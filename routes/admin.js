const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { db, generatePassword, generateUsername } = require('../database');
const { upload, deleteFile } = require('../cloudinary');
const { requireAdmin } = require('../middleware/auth');
let cheerio;
try { cheerio = require('cheerio'); } catch (e) { /* cheerio not installed */ }

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
        // Debug: log the files data
        console.log('Files for exam', examId, ':', JSON.stringify(result.rows, null, 2));
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch files' });
    }
});

// Debug endpoint to check file data
router.get('/files/debug/:fileId', requireAdmin, async (req, res) => {
    const fileId = parseInt(req.params.fileId);
    try {
        const result = await db.execute({
            sql: 'SELECT * FROM files WHERE id = ?',
            args: [fileId]
        });
        res.json({
            file: result.rows[0],
            raw: result.rows[0] ? Object.keys(result.rows[0]).map(k => ({ key: k, value: result.rows[0][k], type: typeof result.rows[0][k] })) : []
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch file' });
    }
});

router.post('/files/upload', requireAdmin, upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    // Debug: log the file object from Cloudinary
    console.log('Uploaded file object:', JSON.stringify(req.file, null, 2));

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

        // Get the Cloudinary URL - try different properties
        const fileUrl = req.file.path || req.file.secure_url || req.file.url;
        console.log('File URL being saved:', fileUrl);

        const result = await db.execute({
            sql: 'INSERT INTO files (exam_id, display_name, filename, file_url, public_id, file_type, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
            args: [parseInt(examId), name, req.file.originalname, fileUrl, req.file.filename, fileType, sortOrder]
        });

        res.json({
            success: true,
            file: {
                id: Number(result.lastInsertRowid),
                display_name: name,
                file_url: fileUrl,
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
    const { displayName, sortOrder, roomNumber, itemType, itemNumber } = req.body;

    try {
        await db.execute({
            sql: 'UPDATE files SET display_name = ?, sort_order = ?, room_number = ?, item_type = ?, item_number = ? WHERE id = ?',
            args: [displayName, sortOrder, roomNumber || null, itemType || null, itemNumber || null, fileId]
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

// Add files from repository to exam
router.post('/files/from-repository', requireAdmin, async (req, res) => {
    const { examId, repositoryIds } = req.body;

    if (!examId || !repositoryIds || !Array.isArray(repositoryIds) || repositoryIds.length === 0) {
        return res.status(400).json({ error: 'Exam ID and repository file IDs are required' });
    }

    try {
        const maxOrderResult = await db.execute({
            sql: 'SELECT MAX(sort_order) as max_order FROM files WHERE exam_id = ?',
            args: [parseInt(examId)]
        });
        let sortOrder = (maxOrderResult.rows[0].max_order || 0) + 1;

        const added = [];

        for (const repoId of repositoryIds) {
            // Get the repository file
            const repoResult = await db.execute({
                sql: 'SELECT * FROM repository WHERE id = ?',
                args: [parseInt(repoId)]
            });
            const repoFile = repoResult.rows[0];

            if (repoFile) {
                // Add to exam files (reference the same Cloudinary file)
                const result = await db.execute({
                    sql: 'INSERT INTO files (exam_id, display_name, filename, file_url, public_id, file_type, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    args: [parseInt(examId), repoFile.display_name, repoFile.filename, repoFile.file_url, repoFile.public_id, repoFile.file_type, sortOrder]
                });

                added.push({
                    id: Number(result.lastInsertRowid),
                    display_name: repoFile.display_name,
                    file_type: repoFile.file_type
                });

                sortOrder++;

                // If this is a stem, also add its linked clinical images
                if (repoFile.category === 'stem') {
                    const linkedImages = await db.execute({
                        sql: 'SELECT * FROM repository WHERE related_stem_id = ?',
                        args: [parseInt(repoId)]
                    });

                    for (const img of linkedImages.rows) {
                        const imgResult = await db.execute({
                            sql: 'INSERT INTO files (exam_id, display_name, filename, file_url, public_id, file_type, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
                            args: [parseInt(examId), img.display_name, img.filename, img.file_url, img.public_id, img.file_type, sortOrder]
                        });

                        added.push({
                            id: Number(imgResult.lastInsertRowid),
                            display_name: img.display_name,
                            file_type: img.file_type
                        });

                        sortOrder++;
                    }
                }
            }
        }

        res.json({ success: true, added });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add files to exam' });
    }
});

// Get repository stems with their linked images for selection
router.get('/files/repository-stems', requireAdmin, async (req, res) => {
    try {
        const stems = await db.execute(`
            SELECT r.*,
                   GROUP_CONCAT(ci.id) as linked_image_ids,
                   GROUP_CONCAT(ci.display_name) as linked_image_names
            FROM repository r
            LEFT JOIN repository ci ON ci.related_stem_id = r.id
            WHERE r.category = 'stem'
            GROUP BY r.id
            ORDER BY r.display_name
        `);
        res.json(stems.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch repository stems' });
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
        // Debug: log repository data
        console.log('Repository files:', JSON.stringify(result.rows.map(r => ({ id: r.id, name: r.display_name, file_url: r.file_url })), null, 2));
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
        const { category, displayName, relatedStemId, specialty } = req.body;
        const results = [];

        // Helper to get file URL from Cloudinary response
        const getFileUrl = (file) => file.path || file.secure_url || file.url;

        // Debug: log all uploaded files
        console.log('Repository upload - files:', JSON.stringify(req.files, null, 2));

        if (req.files.stemFile) {
            const stemFile = req.files.stemFile[0];
            const stemFileType = stemFile.mimetype === 'application/pdf' ? 'pdf' : 'image';
            const stemName = req.body.stemDisplayName || stemFile.originalname.replace(/\.[^/.]+$/, '');
            const stemUrl = getFileUrl(stemFile);
            console.log('Stem file URL:', stemUrl);

            const stemResult = await db.execute({
                sql: 'INSERT INTO repository (display_name, filename, file_url, public_id, file_type, category, related_stem_id, specialty) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                args: [stemName, stemFile.originalname, stemUrl, stemFile.filename, stemFileType, 'stem', null, specialty || null]
            });
            const stemId = Number(stemResult.lastInsertRowid);
            results.push({ id: stemId, type: 'stem', name: stemName, url: stemUrl });

            if (req.files.clinicalImage) {
                const clinicalFile = req.files.clinicalImage[0];
                const clinicalFileType = clinicalFile.mimetype === 'application/pdf' ? 'pdf' : 'image';
                const clinicalName = req.body.clinicalDisplayName || clinicalFile.originalname.replace(/\.[^/.]+$/, '');
                const clinicalUrl = getFileUrl(clinicalFile);
                console.log('Clinical file URL:', clinicalUrl);

                const clinicalResult = await db.execute({
                    sql: 'INSERT INTO repository (display_name, filename, file_url, public_id, file_type, category, related_stem_id, specialty) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    args: [clinicalName, clinicalFile.originalname, clinicalUrl, clinicalFile.filename, clinicalFileType, 'clinical_image', stemId, specialty || null]
                });
                results.push({ id: Number(clinicalResult.lastInsertRowid), type: 'clinical_image', name: clinicalName, relatedTo: stemId, url: clinicalUrl });
            }
        } else if (req.files.file) {
            const file = req.files.file[0];
            const fileType = file.mimetype === 'application/pdf' ? 'pdf' : 'image';
            const name = displayName || file.originalname.replace(/\.[^/.]+$/, '');
            const fileUrl = getFileUrl(file);
            console.log('Single file URL:', fileUrl);

            const result = await db.execute({
                sql: 'INSERT INTO repository (display_name, filename, file_url, public_id, file_type, category, related_stem_id, specialty) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                args: [name, file.originalname, fileUrl, file.filename, fileType, category || 'stem', category === 'clinical_image' && relatedStemId ? parseInt(relatedStemId) : null, specialty || null]
            });
            results.push({ id: Number(result.lastInsertRowid), type: category, name: name, url: fileUrl });
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
    const { displayName, specialty } = req.body;

    try {
        await db.execute({
            sql: 'UPDATE repository SET display_name = ?, specialty = ? WHERE id = ?',
            args: [displayName, specialty || null, fileId]
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

// === QUESTION TRACKER ===

router.get('/question-tracker', requireAdmin, (req, res) => {
    res.sendFile('admin/question-tracker.html', { root: './views' });
});

// --- RESIDENT MANAGEMENT ---

// Get all residents from residents table
router.get('/question-tracker/residents', requireAdmin, async (req, res) => {
    try {
        const residents = await db.execute(`
            SELECT r.*,
                   COUNT(qh.id) as question_count,
                   COUNT(DISTINCT qh.specialty) as topic_count
            FROM residents r
            LEFT JOIN question_history qh ON qh.resident_id = r.id
            GROUP BY r.id
            ORDER BY r.pgy_level DESC, r.name
        `);

        res.json({ residents: residents.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load residents' });
    }
});

// Add a new resident
router.post('/question-tracker/residents', requireAdmin, async (req, res) => {
    const { name, pgyLevel, startYear, status, email } = req.body;
    if (!name || !pgyLevel || !startYear) {
        return res.status(400).json({ error: 'Name, PGY level, and start year are required' });
    }
    try {
        await db.execute({
            sql: 'INSERT INTO residents (name, pgy_level, start_year, status, email) VALUES (?, ?, ?, ?, ?)',
            args: [name, parseInt(pgyLevel), parseInt(startYear), status || 'active', email || null]
        });
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add resident' });
    }
});

// Update a resident
router.put('/question-tracker/residents/:id', requireAdmin, async (req, res) => {
    const { name, pgyLevel, status, email } = req.body;
    try {
        await db.execute({
            sql: 'UPDATE residents SET name = ?, pgy_level = ?, status = ?, email = ? WHERE id = ?',
            args: [name, parseInt(pgyLevel), status, email || null, parseInt(req.params.id)]
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update resident' });
    }
});

// Delete a resident
router.delete('/question-tracker/residents/:id', requireAdmin, async (req, res) => {
    try {
        await db.execute({ sql: 'DELETE FROM residents WHERE id = ?', args: [parseInt(req.params.id)] });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete resident' });
    }
});

// Annual advancement: advance all active residents by 1 PGY, graduate PGY-5s
router.post('/question-tracker/advance-year', requireAdmin, async (req, res) => {
    try {
        // Graduate PGY-5 chiefs
        const graduated = await db.execute(
            "UPDATE residents SET status = 'graduated' WHERE pgy_level >= 5 AND status = 'active'"
        );
        // Move research residents back to active
        await db.execute(
            "UPDATE residents SET status = 'active' WHERE status = 'research'"
        );
        // Advance everyone by 1 year
        await db.execute(
            "UPDATE residents SET pgy_level = pgy_level + 1 WHERE status = 'active'"
        );
        res.json({ success: true, graduated: graduated.rowsAffected });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to advance year' });
    }
});

// Sync residents from ECU surgery website
router.post('/question-tracker/sync-residents', requireAdmin, async (req, res) => {
    if (!cheerio) {
        return res.status(500).json({ error: 'cheerio package not installed. Run: npm install cheerio' });
    }

    const ECU_URL = 'https://surgery.ecu.edu/residency/current-residents/meet-the-residents/';

    try {
        // Fetch the ECU residents page
        const response = await fetch(ECU_URL);
        if (!response.ok) throw new Error(`Failed to fetch page: ${response.status}`);
        const html = await response.text();
        const $ = cheerio.load(html);

        // Map heading text to PGY levels
        const pgyMap = {
            'chief residents': { pgy: 5, status: 'active' },
            'chief': { pgy: 5, status: 'active' },
            'fifth year': { pgy: 5, status: 'active' },
            'fourth year': { pgy: 4, status: 'active' },
            'research': { pgy: 4, status: 'research' },
            'research year': { pgy: 4, status: 'research' },
            'third year': { pgy: 3, status: 'active' },
            'second year': { pgy: 2, status: 'active' },
            'first year': { pgy: 1, status: 'active' },
        };

        // Parse residents from the page
        const scrapedResidents = [];
        let currentPgy = null;
        let currentStatus = 'active';

        // Walk through the content looking for h2 headings and strong/bold names
        const content = $('.entry-content, .page-content, article, main, #content, .content-area').first();
        const container = content.length ? content : $('body');

        container.find('h2, strong, b').each(function() {
            const el = $(this);
            const text = el.text().trim();

            // Check if this is a year heading
            if (el.is('h2')) {
                const lower = text.toLowerCase();
                for (const [key, val] of Object.entries(pgyMap)) {
                    if (lower.includes(key)) {
                        currentPgy = val.pgy;
                        currentStatus = val.status;
                        break;
                    }
                }
                return;
            }

            // Check if this is a resident name (contains MD or DO)
            if (currentPgy && (text.includes(', MD') || text.includes(', DO'))) {
                // Filter out school names - they typically contain words like University, School, College, Medical
                const schoolWords = ['university', 'school', 'college', 'medical', 'institute'];
                const isSchool = schoolWords.some(w => text.toLowerCase().includes(w));
                if (!isSchool) {
                    scrapedResidents.push({
                        name: text.trim(),
                        pgy: currentPgy,
                        status: currentStatus
                    });
                }
            }
        });

        if (scrapedResidents.length === 0) {
            return res.status(400).json({ error: 'Could not find any residents on the page. The page structure may have changed.' });
        }

        // Get existing residents
        const existing = await db.execute('SELECT name FROM residents');
        const existingNames = new Set(existing.rows.map(r => r.name.toLowerCase()));

        // Determine current academic year for start_year
        const now = new Date();
        const currentYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;

        // Insert new residents, update PGY for existing ones
        let added = 0;
        let updated = 0;

        for (const r of scrapedResidents) {
            if (existingNames.has(r.name.toLowerCase())) {
                // Update PGY level and status for existing residents
                await db.execute({
                    sql: 'UPDATE residents SET pgy_level = ?, status = ? WHERE LOWER(name) = LOWER(?)',
                    args: [r.pgy, r.status, r.name]
                });
                updated++;
            } else {
                // Calculate start year from PGY level
                const startYear = currentYear - r.pgy + 1;
                await db.execute({
                    sql: 'INSERT INTO residents (name, pgy_level, start_year, status) VALUES (?, ?, ?, ?)',
                    args: [r.name, r.pgy, startYear, r.status]
                });
                added++;
            }
        }

        res.json({
            success: true,
            scraped: scrapedResidents.length,
            added,
            updated,
            residents: scrapedResidents
        });
    } catch (err) {
        console.error('Sync residents error:', err);
        res.status(500).json({ error: 'Failed to sync residents: ' + err.message });
    }
});

// --- QUESTION HISTORY ---

// Get a resident's full question history and coverage
router.get('/question-tracker/resident/:id', requireAdmin, async (req, res) => {
    const residentId = parseInt(req.params.id);
    try {
        const resident = await db.execute({
            sql: 'SELECT * FROM residents WHERE id = ?',
            args: [residentId]
        });

        if (!resident.rows[0]) {
            return res.status(404).json({ error: 'Resident not found' });
        }

        const name = resident.rows[0].name;

        // Get question history with exam details
        const history = await db.execute({
            sql: `SELECT qh.*, e.name as exam_name, e.date as exam_date
                  FROM question_history qh
                  LEFT JOIN exams e ON qh.exam_id = e.id
                  WHERE qh.resident_id = ? OR qh.resident_name = ?
                  ORDER BY qh.recorded_at DESC`,
            args: [residentId, name]
        });

        // Get all specialties from repository stems
        const allTopics = await db.execute(`
            SELECT DISTINCT specialty FROM repository
            WHERE category = 'stem' AND specialty IS NOT NULL AND specialty != ''
            ORDER BY specialty
        `);

        // Get tested specialties for this resident
        const testedTopics = await db.execute({
            sql: `SELECT DISTINCT specialty FROM question_history
                  WHERE (resident_id = ? OR resident_name = ?) AND specialty IS NOT NULL AND specialty != ''`,
            args: [residentId, name]
        });

        // Get all exams
        const exams = await db.execute('SELECT id, name, date FROM exams ORDER BY date DESC');

        res.json({
            resident: resident.rows[0],
            history: history.rows,
            allTopics: allTopics.rows.map(r => r.specialty),
            testedTopics: testedTopics.rows.map(r => r.specialty),
            exams: exams.rows
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load resident data' });
    }
});

// Record a question as tested for a resident
router.post('/question-tracker/record', requireAdmin, async (req, res) => {
    const { residentId, examId, repositoryStemId } = req.body;

    if (!residentId || !examId) {
        return res.status(400).json({ error: 'Resident and exam are required' });
    }

    try {
        // Get resident name
        const resident = await db.execute({
            sql: 'SELECT name FROM residents WHERE id = ?',
            args: [parseInt(residentId)]
        });
        const residentName = resident.rows[0]?.name || 'Unknown';

        let stemName = 'Unknown';
        let specialty = null;

        if (repositoryStemId) {
            const stem = await db.execute({
                sql: 'SELECT display_name, specialty FROM repository WHERE id = ?',
                args: [parseInt(repositoryStemId)]
            });
            if (stem.rows[0]) {
                stemName = stem.rows[0].display_name;
                specialty = stem.rows[0].specialty;
            }
        }

        await db.execute({
            sql: `INSERT INTO question_history
                  (resident_id, resident_name, exam_id, repository_stem_id, stem_display_name, specialty, recorded_by)
                  VALUES (?, ?, ?, ?, ?, ?, 'manual')`,
            args: [parseInt(residentId), residentName, parseInt(examId),
                   repositoryStemId ? parseInt(repositoryStemId) : null, stemName, specialty]
        });

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to record question' });
    }
});

// Import questions from an exam for specific residents
router.post('/question-tracker/import-exam', requireAdmin, async (req, res) => {
    const { examId } = req.body;

    try {
        // Get all residents in this exam via credentials
        const credentials = await db.execute({
            sql: `SELECT DISTINCT c.examinee_name, c.resident_id, r.name as resident_table_name
                  FROM credentials c
                  LEFT JOIN residents r ON c.resident_id = r.id
                  WHERE c.exam_id = ? AND (c.examinee_name IS NOT NULL AND c.examinee_name != '')`,
            args: [parseInt(examId)]
        });

        if (credentials.rows.length === 0) {
            return res.status(400).json({ error: 'No residents found for this exam' });
        }

        // Get all stems linked to this exam
        const stems = await db.execute({
            sql: `SELECT DISTINCT r.id, r.display_name, r.specialty, f.room_number
                  FROM files f
                  JOIN repository r ON f.public_id = r.public_id OR f.display_name = r.display_name
                  WHERE f.exam_id = ? AND r.category = 'stem'`,
            args: [parseInt(examId)]
        });

        let imported = 0;
        for (const cred of credentials.rows) {
            const resName = cred.resident_table_name || cred.examinee_name;
            const resId = cred.resident_id;

            for (const stem of stems.rows) {
                const existing = await db.execute({
                    sql: `SELECT id FROM question_history
                          WHERE resident_name = ? AND exam_id = ? AND repository_stem_id = ?`,
                    args: [resName, parseInt(examId), stem.id]
                });

                if (existing.rows.length === 0) {
                    await db.execute({
                        sql: `INSERT INTO question_history
                              (resident_id, resident_name, exam_id, repository_stem_id, stem_display_name, specialty, room_number, recorded_by)
                              VALUES (?, ?, ?, ?, ?, ?, ?, 'auto')`,
                        args: [resId, resName, parseInt(examId), stem.id, stem.display_name, stem.specialty, stem.room_number]
                    });
                    imported++;
                }
            }
        }

        res.json({ success: true, imported });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to import exam data' });
    }
});

// Delete a question history record
router.delete('/question-tracker/:id', requireAdmin, async (req, res) => {
    try {
        await db.execute({
            sql: 'DELETE FROM question_history WHERE id = ?',
            args: [parseInt(req.params.id)]
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete record' });
    }
});

// Get all repository stems for dropdowns
router.get('/question-tracker/stems', requireAdmin, async (req, res) => {
    try {
        const stems = await db.execute(`
            SELECT id, display_name, specialty FROM repository
            WHERE category = 'stem'
            ORDER BY specialty, display_name
        `);
        res.json({ stems: stems.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load stems' });
    }
});

// Get all exams for dropdowns
router.get('/question-tracker/exams', requireAdmin, async (req, res) => {
    try {
        const exams = await db.execute('SELECT id, name, date FROM exams ORDER BY date DESC');
        res.json({ exams: exams.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load exams' });
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
