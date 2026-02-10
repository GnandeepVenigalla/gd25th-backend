require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const multerS3 = require('multer-s3');
const {
    S3Client,
    PutObjectCommand,
    CreateMultipartUploadCommand,
    UploadPartCommand,
    CompleteMultipartUploadCommand
} = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@aws-sdk/node-http-handler');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
    origin: '*', // To simplify development, allow all origins
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true
}));
app.use(express.json({ limit: '5gb' }));
app.use(express.urlencoded({ limit: '5gb', extended: true }));

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI, { family: 4 })
    .then(() => console.log('MongoDB Connected'))
    .catch(err => {
        console.error('MongoDB Connection Error:', err);
        // Retry connection logic could go here, or just log
    });

// Schemas & Models
const mediaSchema = new mongoose.Schema({
    key: String,
    url: String,
    originalName: String,
    uploadDate: { type: Date, default: Date.now }
});

const ImageModel = mongoose.model('Image', mediaSchema);
const VideoModel = mongoose.model('Video', mediaSchema);

// AWS S3 Configuration with extended timeout
const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
    requestHandler: new NodeHttpHandler({
        connectionTimeout: 3600000, // 1 hour
        socketTimeout: 3600000, // 1 hour
    }),
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
});

// Multer Upload Configuration
const upload = multer({
    limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5GB limit
    storage: multerS3({
        s3: s3,
        bucket: process.env.AWS_BUCKET_NAME,
        metadata: function (req, file, cb) {
            cb(null, { fieldName: file.fieldname });
        },
        key: function (req, file, cb) {
            const fileName = `${Date.now().toString()}-${file.originalname}`;
            cb(null, fileName);
        },
    }),
});

// Routes
app.get('/', (req, res) => {
    res.send('GD Backend Server is Running');
});

// Admin Login Route (Simple)
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === process.env.ADMIN_PASSWORD) {
        res.json({ success: true, token: 'gd-admin-token-123' }); // Simple token
    } else {
        res.status(401).json({ success: false, message: 'Invalid password' });
    }
});

// List Media Route (Fetch from MongoDB)
app.get('/api/media', async (req, res) => {
    try {
        const images = await ImageModel.find().sort({ uploadDate: -1 });
        const videos = await VideoModel.find().sort({ uploadDate: -1 });

        res.json({
            success: true,
            data: {
                images: images.map(img => ({
                    _id: img._id,
                    key: img.key,
                    url: img.url,
                    lastModified: img.uploadDate
                })),
                videos: videos.map(vid => ({
                    _id: vid._id,
                    key: vid.key,
                    url: vid.url,
                    lastModified: vid.uploadDate
                }))
            }
        });
    } catch (error) {
        console.error('Error fetching media:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch media' });
    }
});

// --- MULTIPART UPLOAD ENDPOINTS ---

// 1. Start Multipart Upload
app.post('/api/upload/start', async (req, res) => {
    try {
        const { filename, filetype } = req.body;
        const key = `${Date.now().toString()}-${filename}`;

        const command = new CreateMultipartUploadCommand({
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: key,
            ContentType: filetype,
        });

        const response = await s3.send(command);
        res.json({
            success: true,
            uploadId: response.UploadId,
            key: key
        });
    } catch (error) {
        console.error('Error starting multipart upload:', error);
        res.status(500).json({ success: false, message: 'Failed to start upload' });
    }
});

// 2. Get Presigned URL for a Part
app.post('/api/upload/get-part-url', async (req, res) => {
    try {
        const { key, uploadId, partNumber } = req.body;

        const command = new UploadPartCommand({
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
        });

        const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
        res.json({ success: true, url });
    } catch (error) {
        console.error('Error getting part URL:', error);
        res.status(500).json({ success: false, message: 'Failed to get part URL' });
    }
});

// 3. Complete Multipart Upload
app.post('/api/upload/complete', async (req, res) => {
    try {
        const { key, uploadId, parts, originalName } = req.body;

        const command = new CompleteMultipartUploadCommand({
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: {
                Parts: parts.sort((a, b) => a.PartNumber - b.PartNumber)
            }
        });

        await s3.send(command);

        // Save to MongoDB
        const ext = path.extname(originalName).toLowerCase();
        let NewMediaModel = null;

        const imageExtensions = ['.jpg', '.jpeg', '.png', '.heic', '.webp', '.avif', '.heif'];
        const videoExtensions = ['.mp4', '.mov', '.move', '.m4v', '.qt'];

        if (imageExtensions.includes(ext)) {
            NewMediaModel = ImageModel;
        } else if (videoExtensions.includes(ext)) {
            NewMediaModel = VideoModel;
        }

        if (NewMediaModel) {
            const newMedia = new NewMediaModel({
                key: key,
                url: `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`,
                originalName: originalName
            });
            await newMedia.save();
        }

        res.json({ success: true, message: 'Upload completed and saved' });
    } catch (error) {
        console.error('Error completing multipart upload:', error);
        res.status(500).json({ success: false, message: 'Failed to complete upload' });
    }
});

// Upload Route (Upload to S3 & Save to MongoDB) - Increased to 100 files
app.post('/api/upload', upload.array('files', 100), async (req, res) => {
    console.log('Upload request received');

    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, message: 'No files uploaded' });
    }

    const savedFiles = [];

    try {
        for (const file of req.files) {
            console.log('Processing file:', file.originalname);
            const ext = path.extname(file.originalname).toLowerCase();
            let NewMediaModel = null;

            const imageExtensions = ['.jpg', '.jpeg', '.png', '.heic', '.webp', '.avif', '.heif'];
            const videoExtensions = ['.mp4', '.mov', '.move', '.m4v', '.qt'];

            if (imageExtensions.includes(ext)) {
                NewMediaModel = ImageModel;
            } else if (videoExtensions.includes(ext)) {
                NewMediaModel = VideoModel;
            }

            if (NewMediaModel) {
                const newMedia = new NewMediaModel({
                    key: file.key, // S3 key
                    url: file.location, // S3 URL
                    originalName: file.originalname
                });
                await newMedia.save();
                savedFiles.push(file.location);
                console.log('Saved to DB:', file.originalname);
            }
        }

        res.json({
            success: true,
            message: 'Files uploaded and saved successfully',
            files: savedFiles
        });
    } catch (error) {
        console.error('Error saving to DB:', error);
        res.status(500).json({ success: false, message: 'Upload successful but DB save failed' });
    }
});

// Error Handling Middleware
app.use((err, req, res, next) => {
    console.error('SERVER ERROR:', err);
    if (err instanceof multer.MulterError) {
        return res.status(400).json({ success: false, message: err.message });
    }
    res.status(500).json({ success: false, message: err.message });
});

const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

server.setTimeout(3600000); // 1 hour timeout for large files
server.keepAliveTimeout = 3600000; // 1 hour
server.headersTimeout = 3600000 + 1000; // slightly higher than keepAliveTimeout
server.requestTimeout = 3600000; // 1 hour for the entire request
