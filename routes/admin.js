const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { examQueries, credentialQueries, fileQueries, repositoryQueries, adminQueries, generatePassword, generateUsername } = require('../database');
const { requireAdmin } = require('../middleware/auth');

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const fileFilter = (req, file, cb) => {
    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif'];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only PDF, JPG, PNG, and GIF are allowed.'), false);
    }
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// Admin dashboard
router.get('/', requireAdmin, (req, res) => {
    res.sendFile('admin/dashboard.html', { root: './views' });
});

// Admin dashboard data
router.get('/dashboard-data', requireAdmin, (req, res) => {
    const stats = credentialQueries.getStats.all();
    const activeExam = examQueries.findActive.get();
    res.json({ stats, activeExam, adminUsername: req.session.admin.username });
});

// === EXAM MANAGEMENT ===

router.get('/exams', requireAdmin, (req, res) => {
    res.sendFile('admin/exams.html', { root: './views' });
});

router.get('/exams/list', requireAdmin, (req, res) => {
    const exams = examQueries.findAll.all();
    res.json(exams);
});

router.post('/exams', requireAdmin, (req, res) => {
    const { name, date } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Exam name is required' });
    }
    try {
        const result = examQueries.create.run(name, date || null, 0);
        res.json({ success: true, id: result.lastInsertRowid });
    } catch (err) {
        res.status(500).json({ error: 'Failed to create exam' });
    }
});

router.put('/exams/:id', requireAdmin, (req, res) => {
    const { name, date, is_active } = req.body;
    const examId = parseInt(req.params.id);

    try {
        if (is_active) {
            // Deactivate all other exams first
            examQueries.deactivateAll.run();
        }
        examQueries.update.run(name, date || null, is_active ? 1 : 0, examId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update exam' });
    }
});

router.delete('/exams/:id', requireAdmin, (req, res) => {
    const examId = parseInt(req.params.id);
    try {
        // Delete associated files from filesystem
        const files = fileQueries.findByExam.all(examId);
        files.forEach(file => {
            const filePath = path.join(__dirname, '..', 'uploads', file.filename);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        });
        examQueries.delete.run(examId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete exam' });
    }
});

// === CREDENTIAL MANAGEMENT ===

router.get('/credentials', requireAdmin, (req, res) => {
    res.sendFile('admin/credentials.html', { root: './views' });
});

router.get('/credentials/list/:examId', requireAdmin, (req, res) => {
    const examId = parseInt(req.params.examId);
    const credentials = credentialQueries.findByExam.all(examId);
    const counts = credentialQueries.countByExam.get(examId);
    res.json({ credentials, total: counts.total || 0, used: counts.used || 0 });
});

router.post('/credentials/generate', requireAdmin, (req, res) => {
    const { examId, count, prefix } = req.body;

    if (!examId || !count || count < 1 || count > 100) {
        return res.status(400).json({ error: 'Invalid parameters' });
    }

    try {
        const existing = credentialQueries.findByExam.all(examId);
        let startIndex = existing.length + 1;
        const generated = [];

        for (let i = 0; i < count; i++) {
            const username = prefix ?
                `${prefix}${(startIndex + i).toString().padStart(3, '0')}` :
                generateUsername(examId, startIndex + i);
            const password = generatePassword();

            credentialQueries.create.run(examId, username, password, null);
            generated.push({ username, password });
        }

        res.json({ success: true, generated });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to generate credentials' });
    }
});

router.post('/credentials', requireAdmin, (req, res) => {
    const { examId, username, password, examineeName } = req.body;

    if (!examId || !username || !password) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        credentialQueries.create.run(examId, username.toUpperCase(), password, examineeName || null);
        res.json({ success: true });
    } catch (err) {
        if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Username already exists' });
        }
        res.status(500).json({ error: 'Failed to create credential' });
    }
});

router.post('/credentials/:id/reset', requireAdmin, (req, res) => {
    const credId = parseInt(req.params.id);
    try {
        credentialQueries.reset.run(credId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to reset credential' });
    }
});

router.put('/credentials/:id', requireAdmin, (req, res) => {
    const credId = parseInt(req.params.id);
    const { examineeName } = req.body;
    try {
        credentialQueries.updateName.run(examineeName || null, credId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update credential' });
    }
});

router.delete('/credentials/:id', requireAdmin, (req, res) => {
    const credId = parseInt(req.params.id);
    try {
        credentialQueries.delete.run(credId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete credential' });
    }
});

router.delete('/credentials/exam/:examId', requireAdmin, (req, res) => {
    const examId = parseInt(req.params.examId);
    try {
        credentialQueries.deleteByExam.run(examId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete credentials' });
    }
});

// === FILE MANAGEMENT ===

router.get('/files', requireAdmin, (req, res) => {
    res.sendFile('admin/files.html', { root: './views' });
});

router.get('/files/list/:examId', requireAdmin, (req, res) => {
    const examId = parseInt(req.params.examId);
    const files = fileQueries.findByExam.all(examId);
    res.json(files);
});

router.post('/files/upload', requireAdmin, upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const { examId, displayName } = req.body;
    if (!examId) {
        // Delete uploaded file if no exam ID
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Exam ID is required' });
    }

    try {
        const maxOrder = fileQueries.getMaxSortOrder.get(parseInt(examId));
        const sortOrder = (maxOrder.max_order || 0) + 1;

        const fileType = req.file.mimetype === 'application/pdf' ? 'pdf' : 'image';
        const name = displayName || req.file.originalname;

        const result = fileQueries.create.run(
            parseInt(examId),
            name,
            req.file.filename,
            fileType,
            sortOrder
        );

        res.json({
            success: true,
            file: {
                id: result.lastInsertRowid,
                display_name: name,
                filename: req.file.filename,
                file_type: fileType,
                sort_order: sortOrder
            }
        });
    } catch (err) {
        console.error(err);
        fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Failed to save file' });
    }
});

router.put('/files/:id', requireAdmin, (req, res) => {
    const fileId = parseInt(req.params.id);
    const { displayName, sortOrder } = req.body;

    try {
        fileQueries.update.run(displayName, sortOrder, fileId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update file' });
    }
});

router.delete('/files/:id', requireAdmin, (req, res) => {
    const fileId = parseInt(req.params.id);
    try {
        const file = fileQueries.findById.get(fileId);
        if (file) {
            const filePath = path.join(__dirname, '..', 'uploads', file.filename);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            fileQueries.delete.run(fileId);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete file' });
    }
});

// Serve uploaded files for admin preview
router.get('/files/preview/:filename', requireAdmin, (req, res) => {
    const filePath = path.join(__dirname, '..', 'uploads', req.params.filename);
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send('File not found');
    }
});

// === REPOSITORY (Standalone File Management) ===

router.get('/repository', requireAdmin, (req, res) => {
    res.sendFile('admin/repository.html', { root: './views' });
});

router.get('/repository/list', requireAdmin, (req, res) => {
    try {
        const files = repositoryQueries.findAll.all();
        res.json(files);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch files' });
    }
});

router.get('/repository/stems', requireAdmin, (req, res) => {
    try {
        const stems = repositoryQueries.findStems.all();
        res.json(stems);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch stems' });
    }
});

router.get('/repository/:id', requireAdmin, (req, res) => {
    try {
        const file = repositoryQueries.findById.get(parseInt(req.params.id));
        if (!file) {
            return res.status(404).json({ error: 'File not found' });
        }
        // Get related images if this is a stem
        if (file.category === 'stem') {
            file.relatedImages = repositoryQueries.findByStemId.all(file.id);
        }
        res.json(file);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch file' });
    }
});

// Upload to repository - supports multiple files
router.post('/repository/upload', requireAdmin, upload.fields([
    { name: 'stemFile', maxCount: 1 },
    { name: 'clinicalImage', maxCount: 1 },
    { name: 'file', maxCount: 1 }
]), (req, res) => {
    try {
        const { category, displayName, relatedStemId } = req.body;
        const results = [];

        // Handle stem + clinical image pair upload
        if (req.files.stemFile) {
            const stemFile = req.files.stemFile[0];
            const stemFileType = stemFile.mimetype === 'application/pdf' ? 'pdf' : 'image';
            const stemName = req.body.stemDisplayName || stemFile.originalname.replace(/\.[^/.]+$/, '');

            const stemResult = repositoryQueries.create.run(
                stemName,
                stemFile.filename,
                stemFileType,
                'stem',
                null
            );
            const stemId = stemResult.lastInsertRowid;
            results.push({ id: stemId, type: 'stem', name: stemName });

            // If clinical image uploaded with stem
            if (req.files.clinicalImage) {
                const clinicalFile = req.files.clinicalImage[0];
                const clinicalFileType = clinicalFile.mimetype === 'application/pdf' ? 'pdf' : 'image';
                const clinicalName = req.body.clinicalDisplayName || clinicalFile.originalname.replace(/\.[^/.]+$/, '');

                const clinicalResult = repositoryQueries.create.run(
                    clinicalName,
                    clinicalFile.filename,
                    clinicalFileType,
                    'clinical_image',
                    stemId
                );
                results.push({ id: clinicalResult.lastInsertRowid, type: 'clinical_image', name: clinicalName, relatedTo: stemId });
            }
        }
        // Handle single file upload
        else if (req.files.file) {
            const file = req.files.file[0];
            const fileType = file.mimetype === 'application/pdf' ? 'pdf' : 'image';
            const name = displayName || file.originalname.replace(/\.[^/.]+$/, '');

            const result = repositoryQueries.create.run(
                name,
                file.filename,
                fileType,
                category || 'stem',
                category === 'clinical_image' && relatedStemId ? parseInt(relatedStemId) : null
            );
            results.push({ id: result.lastInsertRowid, type: category, name: name });
        }

        res.json({ success: true, files: results });
    } catch (err) {
        console.error(err);
        // Clean up uploaded files on error
        if (req.files) {
            Object.values(req.files).flat().forEach(file => {
                if (fs.existsSync(file.path)) {
                    fs.unlinkSync(file.path);
                }
            });
        }
        res.status(500).json({ error: 'Failed to upload files' });
    }
});

router.put('/repository/:id', requireAdmin, (req, res) => {
    const fileId = parseInt(req.params.id);
    const { displayName } = req.body;

    try {
        repositoryQueries.update.run(displayName, fileId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update file' });
    }
});

router.put('/repository/:id/associate', requireAdmin, (req, res) => {
    const fileId = parseInt(req.params.id);
    const { stemId } = req.body;

    try {
        repositoryQueries.updateRelatedStem.run(stemId ? parseInt(stemId) : null, fileId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to associate files' });
    }
});

router.delete('/repository/:id', requireAdmin, (req, res) => {
    const fileId = parseInt(req.params.id);
    try {
        const file = repositoryQueries.findById.get(fileId);
        if (file) {
            // Clear references to this file if it's a stem
            if (file.category === 'stem') {
                repositoryQueries.clearRelatedStem.run(fileId);
            }
            // Delete the actual file
            const filePath = path.join(__dirname, '..', 'uploads', file.filename);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            repositoryQueries.delete.run(fileId);
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete file' });
    }
});

router.get('/repository/preview/:filename', requireAdmin, (req, res) => {
    const filePath = path.join(__dirname, '..', 'uploads', req.params.filename);
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send('File not found');
    }
});

// === SETTINGS / PASSWORD CHANGE ===

router.get('/settings', requireAdmin, (req, res) => {
    res.sendFile('admin/settings.html', { root: './views' });
});

router.post('/change-password', requireAdmin, (req, res) => {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmPassword) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    if (newPassword !== confirmPassword) {
        return res.status(400).json({ error: 'New passwords do not match' });
    }

    if (newPassword.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    try {
        const admin = adminQueries.findByUsername.get(req.session.admin.username);

        if (!bcrypt.compareSync(currentPassword, admin.password_hash)) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        const newHash = bcrypt.hashSync(newPassword, 10);
        adminQueries.updatePassword.run(newHash, admin.id);

        res.json({ success: true, message: 'Password changed successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to change password' });
    }
});

module.exports = router;
