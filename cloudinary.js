const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Storage for images
const imageStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'ecu-mock-oral',
        allowed_formats: ['jpg', 'jpeg', 'png', 'gif'],
        resource_type: 'image'
    }
});

// Storage for PDFs (raw files)
const pdfStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'ecu-mock-oral',
        allowed_formats: ['pdf'],
        resource_type: 'raw'
    }
});

// Custom storage that handles both images and PDFs
const customStorage = {
    _handleFile: function(req, file, cb) {
        const isPdf = file.mimetype === 'application/pdf';
        const storage = isPdf ? pdfStorage : imageStorage;
        storage._handleFile(req, file, cb);
    },
    _removeFile: function(req, file, cb) {
        const isPdf = file.mimetype === 'application/pdf';
        const storage = isPdf ? pdfStorage : imageStorage;
        storage._removeFile(req, file, cb);
    }
};

// File filter
const fileFilter = (req, file, cb) => {
    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif'];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only PDF, JPG, PNG, and GIF are allowed.'), false);
    }
};

// Create multer upload instance
const upload = multer({
    storage: customStorage,
    fileFilter: fileFilter,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// Delete file from Cloudinary
async function deleteFile(publicId, resourceType = 'image') {
    try {
        await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
    } catch (err) {
        console.error('Error deleting from Cloudinary:', err);
    }
}

module.exports = {
    cloudinary,
    upload,
    deleteFile
};
