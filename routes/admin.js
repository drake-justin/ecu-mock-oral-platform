const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { db, generatePassword, generateUsername } = require('../database');
const { upload, deleteFile } = require('../cloudinary');
const { requireAdmin } = require('../middleware/auth');

// Admin dashboard
router.get('/', requireAdmin, (req, res) => {
    res.sendFile('admin/dashboard.html', { root: './views' });
});

// Admin dashboard data
router.get('/dashboard-data', requireAdmin, async (req, res) => {
    try {
        const statsResult = await db.execute(`
            SELECT e.id, e.name, e.is_active,
                   COUNT(c.id) as total_credentials,
                   SUM(CASE WHEN c.is_used = 1 THEN 1 ELSE 0 END) as used_credentials
            FROM exams e
            LEFT JOIN credentials c ON e.id = c.exam_id
            GROUP BY e.id
            ORDER BY e.created_at DESC
        `);

        const activeResult = await db.execute('SELECT * FROM exams WHERE is_active = 1 LIMIT 1');

        res.json({
            stats: statsResult.rows,
            activeExam: activeResult.rows[0] || null,
            adminUsername: req.session.admin.username
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load dashboard data' });
    }
});

// === EXAM MANAGEMENT ===

router.get('/exams', requireAdmin, (req, res) => {
    res.sendFile('admin/exams.html', { root: './views' });
});

router.get('/exams/list', requireAdmin, async (req, res) => {
    try {
        const result = await db.execute('SELECT * FROM exams ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch exams' });
    }
});

router.post('/exams', requireAdmin, async (req, res) => {
    const { name, date } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Exam name is required' });
    }
    try {
        const result = await db.execute({
            sql: 'INSERT INTO exams (name, date, is_active) VALUES (?, ?, 0)',
            args: [name, date || null]
        });
        res.json({ success: true, id: Number(result.lastInsertRowid) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to create exam' });
    }
});

router.put('/exams/:id', requireAdmin, async (req, res) => {
    const { name, date, is_active } = req.body;
    const examId = parseInt(req.params.id);

    try {
        if (is_active) {
            await db.execute('UPDATE exams SET is_active = 0');
        }
        await db.execute({
            sql: 'UPDATE exams SET name = ?, date = ?, is_active = ? WHERE id = ?',
            args: [name, date || null, is_active ? 1 : 0, examId]
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update exam' });
    }
});

router.delete('/exams/:id', requireAdmin, async (req, res) => {
    const examId = parseInt(req.params.id);
    try {
        // Get files to delete from Cloudinary
        const filesResult = await db.execute({
            sql: 'SELECT public_id, file_type FROM files WHERE exam_id = ?',
            args: [examId]
        });

        for (const file of filesResult.rows) {
            if (file.public_id) {
                const resourceType = file.file_type === 'pdf' ? 'raw' : 'image';
                await deleteFile(file.public_id, resourceType);
            }
        }

        await db.execute({ sql: 'DELETE FROM exams WHERE id = ?', args: [examId] });
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete exam' });
    }
});

// === CREDENTIAL MANAGEMENT ===

router.get('/credentials', requireAdmin, (req, res) => {
    res.sendFile('admin/credentials.html', { root: './views' });
});

router.get('/credentials/list/:examId', requireAdmin, async (req, res) => {
    const examId = parseInt(req.params.examId);
    try {
        const credsResult = await db.execute({
            sql: 'SELECT * FROM credentials WHERE exam_id = ? ORDER BY username',
            args: [examId]
        });

        const countResult = await db.execute({
            sql: 'SELECT COUNT(*) as total, SUM(is_used) as used FROM credentials WHERE exam_id = ?',
            args: [examId]
        });

        res.json({
            credentials: credsResult.rows,
            total: countResult.rows[0].total || 0,
            used: countResult.rows[0].used || 0
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch credentials' });
    }
});

router.post('/credentials/generate', requireAdmin, async (req, res) => {
    const { examId, count, prefix } = req.body;

    if (!examId || !count || count < 1 || count > 100) {
        return res.status(400).json({ error: 'Invalid parameters' });
    }

    try {
        const existing = await db.execute({
            sql: 'SELECT COUNT(*) as count FROM credentials WHERE exam_id = ?',
            args: [examId]
        });
        let startIndex = (existing.rows[0].count || 0) + 1;
        const generated = [];

        for (let i = 0; i < count; i++) {
            const username = prefix ?
                `${prefix}${(startIndex + i).toString().padStart(3, '0')}` :
                generateUsername(examId, startIndex + i);
            const password = generatePassword();

            await db.execute({
                sql: 'INSERT INTO credentials (exam_id, username, password, examinee_name) VALUES (?, ?, ?, ?)',
                args: [examId, username, password, null]
            });
            generated.push({ username, password });
        }

        res.json({ success: true, generated });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to generate credentials' });
    }
});

router.post('/credentials', requireAdmin, async (req, res) => {
    const { examId, username, password, examineeName } = req.body;

    if (!examId || !username || !password) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        await db.execute({
            sql: 'INSERT INTO credentials (exam_id, username, password, examinee_name) VALUES (?, ?, ?, ?)',
            args: [examId, username.toUpperCase(), password, examineeName || null]
        });
        res.json({ success: true });
    } catch (err) {
        if (err.message && err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Username already exists' });
        }
        res.status(500).json({ error: 'Failed to create credential' });
    }
});

router.post('/credentials/:id/reset', requireAdmin, async (req, res) => {
    const credId = parseInt(req.params.id);
    try {
        await db.execute({
            sql: 'UPDATE credentials SET is_used = 0, used_at = NULL WHERE id = ?',
            args: [credId]
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to reset credential' });
    }
});

router.put('/credentials/:id', requireAdmin, async (req, res) => {
    const credId = parseInt(req.params.id);
    const { examineeName } = req.body;
    try {
        await db.execute({
            sql: 'UPDATE credentials SET examinee_name = ? WHERE id = ?',
            args: [examineeName || null, credId]
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update credential' });
    }
});

router.delete('/credentials/:id', requireAdmin, async (req, res) => {
    const credId = parseInt(req.params.id);
    try {
        await db.execute({
            sql: 'DELETE FROM credentials WHERE id = ?',
            args: [credId]
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete credential' });
    }
});

router.delete('/credentials/exam/:examId', requireAdmin, async (req, res) => {
    const examId = parseInt(req.params.examId);
    try {
        await db.execute({
            sql: 'DELETE FROM credentials WHERE exam_id = ?',
            args: [examId]
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete credentials' });
    }
});

// === FILE MANAGEMENT (Exam Files) ===

router.get('/files', requireAdmin, (req, res) => {
    res.sendFile('admin/files.html', { root: './views' });
});

router.get('/files/list/:examId', requireAdmin, async (req, res) => {
    const examId = parseInt(req.params.examId);
    try {
        const result = await db.execute({
            sql: 'SELECT * FROM files WHERE exam_id = ? ORDER BY sort_order, id',
            args: [examId]
        });
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch files' });
    }
});

router.post('/files/upload', requireAdmin, upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const { examId, displayName } = req.body;
    if (!examId) {
        // Delete from Cloudinary if no exam ID
        if (req.file.filename) {
            const resourceType = req.file.mimetype === 'application/pdf' ? 'raw' : 'image';
            await deleteFile(req.file.filename, resourceType);
        }
        return res.status(400).json({ error: 'Exam ID is required' });
    }

    try {
        const maxOrderResult = await db.execute({
            sql: 'SELECT MAX(sort_order) as max_order FROM files WHERE exam_id = ?',
            args: [parseInt(examId)]
        });
        const sortOrder = (maxOrderResult.rows[0].max_order || 0) + 1;

        const fileType = req.file.mimetype === 'application/pdf' ? 'pdf' : 'image';
        const name = displayName || req.file.originalname;

        const result = await db.execute({
            sql: 'INSERT INTO files (exam_id, display_name, filename, file_url, public_id, file_type, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
            args: [parseInt(examId), name, req.file.originalname, req.file.path, req.file.filename, fileType, sortOrder]
        });

        res.json({
            success: true,
            file: {
                id: Number(result.lastInsertRowid),
                display_name: name,
                file_url: req.file.path,
                file_type: fileType,
                sort_order: sortOrder
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to save file' });
    }
});

router.put('/files/:id', requireAdmin, async (req, res) => {
    const fileId = parseInt(req.params.id);
    const { displayName, sortOrder } = req.body;

    try {
        await db.execute({
            sql: 'UPDATE files SET display_name = ?, sort_order = ? WHERE id = ?',
            args: [displayName, sortOrder, fileId]
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update file' });
    }
});

router.delete('/files/:id', requireAdmin, async (req, res) => {
    const fileId = parseInt(req.params.id);
    try {
        const result = await db.execute({
            sql: 'SELECT public_id, file_type FROM files WHERE id = ?',
            args: [fileId]
        });
        const file = result.rows[0];

        if (file && file.public_id) {
            const resourceType = file.file_type === 'pdf' ? 'raw' : 'image';
            await deleteFile(file.public_id, resourceType);
        }

        await db.execute({ sql: 'DELETE FROM files WHERE id = ?', args: [fileId] });
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete file' });
    }
});

// === REPOSITORY (Standalone File Management) ===

router.get('/repository', requireAdmin, (req, res) => {
    res.sendFile('admin/repository.html', { root: './views' });
});

router.get('/repository/list', requireAdmin, async (req, res) => {
    try {
        const result = await db.execute(`
            SELECT r.*,
                   s.display_name as stem_name
            FROM repository r
            LEFT JOIN repository s ON r.related_stem_id = s.id
            ORDER BY r.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch files' });
    }
});

router.get('/repository/stems', requireAdmin, async (req, res) => {
    try {
        const result = await db.execute(`SELECT * FROM repository WHERE category = 'stem' ORDER BY display_name`);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch stems' });
    }
});

router.get('/repository/:id', requireAdmin, async (req, res) => {
    try {
        const result = await db.execute({
            sql: 'SELECT * FROM repository WHERE id = ?',
            args: [parseInt(req.params.id)]
        });
        const file = result.rows[0];

        if (!file) {
            return res.status(404).json({ error: 'File not found' });
        }

        if (file.category === 'stem') {
            const imagesResult = await db.execute({
                sql: 'SELECT * FROM repository WHERE related_stem_id = ?',
                args: [file.id]
            });
            file.relatedImages = imagesResult.rows;
        }
        res.json(file);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch file' });
    }
});

router.post('/repository/upload', requireAdmin, upload.fields([
    { name: 'stemFile', maxCount: 1 },
    { name: 'clinicalImage', maxCount: 1 },
    { name: 'file', maxCount: 1 }
]), async (req, res) => {
    try {
        const { category, displayName, relatedStemId } = req.body;
        const results = [];

        if (req.files.stemFile) {
            const stemFile = req.files.stemFile[0];
            const stemFileType = stemFile.mimetype === 'application/pdf' ? 'pdf' : 'image';
            const stemName = req.body.stemDisplayName || stemFile.originalname.replace(/\.[^/.]+$/, '');

            const stemResult = await db.execute({
                sql: 'INSERT INTO repository (display_name, filename, file_url, public_id, file_type, category, related_stem_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                args: [stemName, stemFile.originalname, stemFile.path, stemFile.filename, stemFileType, 'stem', null]
            });
            const stemId = Number(stemResult.lastInsertRowid);
            results.push({ id: stemId, type: 'stem', name: stemName });

            if (req.files.clinicalImage) {
                const clinicalFile = req.files.clinicalImage[0];
                const clinicalFileType = clinicalFile.mimetype === 'application/pdf' ? 'pdf' : 'image';
                const clinicalName = req.body.clinicalDisplayName || clinicalFile.originalname.replace(/\.[^/.]+$/, '');

                const clinicalResult = await db.execute({
                    sql: 'INSERT INTO repository (display_name, filename, file_url, public_id, file_type, category, related_stem_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    args: [clinicalName, clinicalFile.originalname, clinicalFile.path, clinicalFile.filename, clinicalFileType, 'clinical_image', stemId]
                });
                results.push({ id: Number(clinicalResult.lastInsertRowid), type: 'clinical_image', name: clinicalName, relatedTo: stemId });
            }
        } else if (req.files.file) {
            const file = req.files.file[0];
            const fileType = file.mimetype === 'application/pdf' ? 'pdf' : 'image';
            const name = displayName || file.originalname.replace(/\.[^/.]+$/, '');

            const result = await db.execute({
                sql: 'INSERT INTO repository (display_name, filename, file_url, public_id, file_type, category, related_stem_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                args: [name, file.originalname, file.path, file.filename, fileType, category || 'stem', category === 'clinical_image' && relatedStemId ? parseInt(relatedStemId) : null]
            });
            results.push({ id: Number(result.lastInsertRowid), type: category, name: name });
        }

        res.json({ success: true, files: results });
    } catch (err) {
        console.error(err);
        // Clean up uploaded files on error
        if (req.files) {
            for (const fileArray of Object.values(req.files)) {
                for (const file of fileArray) {
                    if (file.filename) {
                        const resourceType = file.mimetype === 'application/pdf' ? 'raw' : 'image';
                        await deleteFile(file.filename, resourceType);
                    }
                }
            }
        }
        res.status(500).json({ error: 'Failed to upload files' });
    }
});

router.put('/repository/:id', requireAdmin, async (req, res) => {
    const fileId = parseInt(req.params.id);
    const { displayName } = req.body;

    try {
        await db.execute({
            sql: 'UPDATE repository SET display_name = ? WHERE id = ?',
            args: [displayName, fileId]
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update file' });
    }
});

router.put('/repository/:id/associate', requireAdmin, async (req, res) => {
    const fileId = parseInt(req.params.id);
    const { stemId } = req.body;

    try {
        await db.execute({
            sql: 'UPDATE repository SET related_stem_id = ? WHERE id = ?',
            args: [stemId ? parseInt(stemId) : null, fileId]
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to associate files' });
    }
});

router.delete('/repository/:id', requireAdmin, async (req, res) => {
    const fileId = parseInt(req.params.id);
    try {
        const result = await db.execute({
            sql: 'SELECT * FROM repository WHERE id = ?',
            args: [fileId]
        });
        const file = result.rows[0];

        if (file) {
            if (file.category === 'stem') {
                await db.execute({
                    sql: 'UPDATE repository SET related_stem_id = NULL WHERE related_stem_id = ?',
                    args: [fileId]
                });
            }

            // Delete from Cloudinary
            if (file.public_id) {
                const resourceType = file.file_type === 'pdf' ? 'raw' : 'image';
                await deleteFile(file.public_id, resourceType);
            }

            await db.execute({ sql: 'DELETE FROM repository WHERE id = ?', args: [fileId] });
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete file' });
    }
});

// === SETTINGS / PASSWORD CHANGE ===

router.get('/settings', requireAdmin, (req, res) => {
    res.sendFile('admin/settings.html', { root: './views' });
});

router.post('/change-password', requireAdmin, async (req, res) => {
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
        const result = await db.execute({
            sql: 'SELECT * FROM admins WHERE username = ?',
            args: [req.session.admin.username]
        });
        const admin = result.rows[0];

        if (!bcrypt.compareSync(currentPassword, admin.password_hash)) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        const newHash = bcrypt.hashSync(newPassword, 10);
        await db.execute({
            sql: 'UPDATE admins SET password_hash = ? WHERE id = ?',
            args: [newHash, admin.id]
        });

        res.json({ success: true, message: 'Password changed successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to change password' });
    }
});

module.exports = router;
