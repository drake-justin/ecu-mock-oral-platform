const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { db, generatePassword, generateUsername } = require('../database');
const { upload, deleteFile } = require('../cloudinary');
const { requireAdmin } = require('../middleware/auth');
let cheerio;
try { cheerio = require('cheerio'); } catch (e) { /* cheerio not installed */ }
let emailModule;
try {
    emailModule = require('../email');
    console.log('Email module loaded successfully');
} catch (e) {
    console.error('Email module failed to load:', e.message);
}

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
    const { name, date, startTime } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Exam name is required' });
    }
    try {
        const result = await db.execute({
            sql: 'INSERT INTO exams (name, date, start_time, is_active) VALUES (?, ?, ?, 0)',
            args: [name, date || null, startTime || null]
        });
        res.json({ success: true, id: Number(result.lastInsertRowid) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to create exam' });
    }
});

router.put('/exams/:id', requireAdmin, async (req, res) => {
    const { name, date, startTime, is_active } = req.body;
    const examId = parseInt(req.params.id);

    try {
        if (is_active) {
            await db.execute('UPDATE exams SET is_active = 0');
        }
        await db.execute({
            sql: 'UPDATE exams SET name = ?, date = ?, start_time = ?, is_active = ? WHERE id = ?',
            args: [name, date || null, startTime || null, is_active ? 1 : 0, examId]
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

// === EXAM ROOMS ===

// Get all rooms for an exam with their examiners, files, and assigned residents
router.get('/exams/:id/rooms', requireAdmin, async (req, res) => {
    const examId = parseInt(req.params.id);
    try {
        const rooms = await db.execute({
            sql: 'SELECT * FROM exam_rooms WHERE exam_id = ? ORDER BY room_number',
            args: [examId]
        });

        const examiners = await db.execute({
            sql: 'SELECT * FROM examiners WHERE exam_id = ? ORDER BY room_number',
            args: [examId]
        });

        const files = await db.execute({
            sql: 'SELECT * FROM files WHERE exam_id = ? ORDER BY room_number, sort_order',
            args: [examId]
        });

        const assignments = await db.execute({
            sql: `SELECT era.*, r.name, r.pgy_level
                  FROM exam_room_assignments era
                  JOIN residents r ON era.resident_id = r.id
                  WHERE era.exam_id = ?
                  ORDER BY era.room_number, r.name`,
            args: [examId]
        });

        // Group by room
        const roomData = rooms.rows.map(room => ({
            ...room,
            examiners: examiners.rows.filter(e => e.room_number === room.room_number),
            files: files.rows.filter(f => f.room_number === room.room_number),
            residents: assignments.rows.filter(a => a.room_number === room.room_number)
        }));

        res.json({ rooms: roomData });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load rooms' });
    }
});

// Create a new room
router.post('/exams/:id/rooms', requireAdmin, async (req, res) => {
    const examId = parseInt(req.params.id);
    const { roomName } = req.body;
    try {
        // Get next room number
        const maxResult = await db.execute({
            sql: 'SELECT MAX(room_number) as max_num FROM exam_rooms WHERE exam_id = ?',
            args: [examId]
        });
        const nextNum = (maxResult.rows[0]?.max_num || 0) + 1;

        await db.execute({
            sql: 'INSERT INTO exam_rooms (exam_id, room_number, room_name) VALUES (?, ?, ?)',
            args: [examId, nextNum, roomName || `Room ${nextNum}`]
        });
        res.json({ success: true, roomNumber: nextNum });
    } catch (err) {
        res.status(500).json({ error: 'Failed to create room' });
    }
});

// Delete a room and its associations
router.delete('/exams/:examId/rooms/:roomNumber', requireAdmin, async (req, res) => {
    const examId = parseInt(req.params.examId);
    const roomNum = parseInt(req.params.roomNumber);
    try {
        // Remove files from this room (set room_number to null, or delete)
        await db.execute({
            sql: 'DELETE FROM files WHERE exam_id = ? AND room_number = ?',
            args: [examId, roomNum]
        });
        // Remove examiners for this room
        await db.execute({
            sql: 'DELETE FROM examiners WHERE exam_id = ? AND room_number = ?',
            args: [examId, roomNum]
        });
        // Remove room assignments
        await db.execute({
            sql: 'DELETE FROM exam_room_assignments WHERE exam_id = ? AND room_number = ?',
            args: [examId, roomNum]
        });
        // Delete the room
        await db.execute({
            sql: 'DELETE FROM exam_rooms WHERE exam_id = ? AND room_number = ?',
            args: [examId, roomNum]
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete room' });
    }
});

// === EXAM-RESIDENT MANAGEMENT ===

// Get residents linked to an exam
router.get('/exams/:id/residents', requireAdmin, async (req, res) => {
    try {
        const result = await db.execute({
            sql: `SELECT er.id as link_id, er.credential_id, r.id as resident_id, r.name, r.pgy_level, r.status,
                         c.username, c.password, c.is_used
                  FROM exam_residents er
                  JOIN residents r ON er.resident_id = r.id
                  LEFT JOIN credentials c ON er.credential_id = c.id
                  WHERE er.exam_id = ?
                  ORDER BY r.pgy_level DESC, r.name`,
            args: [parseInt(req.params.id)]
        });
        res.json({ residents: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load exam residents' });
    }
});

// Add residents to an exam (auto-generates credentials)
router.post('/exams/:id/residents', requireAdmin, async (req, res) => {
    const examId = parseInt(req.params.id);
    const { residentIds } = req.body;

    if (!residentIds || !residentIds.length) {
        return res.status(400).json({ error: 'No residents selected' });
    }

    try {
        // Get current max credential index for this exam
        const countResult = await db.execute({
            sql: 'SELECT COUNT(*) as cnt FROM credentials WHERE exam_id = ?',
            args: [examId]
        });
        let credIndex = (countResult.rows[0]?.cnt || 0) + 1;

        let added = 0;
        for (const resId of residentIds) {
            // Check if already linked
            const existing = await db.execute({
                sql: 'SELECT id FROM exam_residents WHERE exam_id = ? AND resident_id = ?',
                args: [examId, parseInt(resId)]
            });
            if (existing.rows.length > 0) continue;

            // Get resident name
            const resident = await db.execute({
                sql: 'SELECT name FROM residents WHERE id = ?',
                args: [parseInt(resId)]
            });
            if (!resident.rows[0]) continue;
            const residentName = resident.rows[0].name;

            // Auto-create credential
            const username = generateUsername(examId, credIndex);
            const password = generatePassword();
            const credResult = await db.execute({
                sql: 'INSERT INTO credentials (exam_id, username, password, examinee_name, resident_id) VALUES (?, ?, ?, ?, ?)',
                args: [examId, username, password, residentName, parseInt(resId)]
            });
            const credentialId = credResult.lastInsertRowid;
            credIndex++;

            // Link resident to exam
            await db.execute({
                sql: 'INSERT INTO exam_residents (exam_id, resident_id, credential_id) VALUES (?, ?, ?)',
                args: [examId, parseInt(resId), credentialId]
            });
            added++;
        }

        res.json({ success: true, added });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add residents' });
    }
});

// Add all residents of a PGY level to an exam
router.post('/exams/:id/residents/by-pgy', requireAdmin, async (req, res) => {
    const examId = parseInt(req.params.id);
    const { pgyLevel } = req.body;

    try {
        const residents = await db.execute({
            sql: "SELECT id FROM residents WHERE pgy_level = ? AND status IN ('active', 'research')",
            args: [parseInt(pgyLevel)]
        });
        const residentIds = residents.rows.map(r => r.id);

        if (residentIds.length === 0) {
            return res.status(400).json({ error: 'No active residents at PGY-' + pgyLevel });
        }

        // Forward to the add residents handler
        req.body.residentIds = residentIds;
        // Reuse logic inline
        const countResult = await db.execute({
            sql: 'SELECT COUNT(*) as cnt FROM credentials WHERE exam_id = ?',
            args: [examId]
        });
        let credIndex = (countResult.rows[0]?.cnt || 0) + 1;
        let added = 0;

        for (const resId of residentIds) {
            const existing = await db.execute({
                sql: 'SELECT id FROM exam_residents WHERE exam_id = ? AND resident_id = ?',
                args: [examId, resId]
            });
            if (existing.rows.length > 0) continue;

            const resident = await db.execute({
                sql: 'SELECT name FROM residents WHERE id = ?',
                args: [resId]
            });
            if (!resident.rows[0]) continue;

            const username = generateUsername(examId, credIndex);
            const password = generatePassword();
            const credResult = await db.execute({
                sql: 'INSERT INTO credentials (exam_id, username, password, examinee_name, resident_id) VALUES (?, ?, ?, ?, ?)',
                args: [examId, username, password, resident.rows[0].name, resId]
            });

            await db.execute({
                sql: 'INSERT INTO exam_residents (exam_id, resident_id, credential_id) VALUES (?, ?, ?)',
                args: [examId, resId, credResult.lastInsertRowid]
            });
            added++;
            credIndex++;
        }

        res.json({ success: true, added });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add PGY class' });
    }
});

// Remove a resident from an exam
router.delete('/exams/:examId/residents/:residentId', requireAdmin, async (req, res) => {
    const examId = parseInt(req.params.examId);
    const residentId = parseInt(req.params.residentId);

    try {
        // Get the credential ID before deleting
        const link = await db.execute({
            sql: 'SELECT credential_id FROM exam_residents WHERE exam_id = ? AND resident_id = ?',
            args: [examId, residentId]
        });

        // Delete credential
        if (link.rows[0]?.credential_id) {
            await db.execute({
                sql: 'DELETE FROM credentials WHERE id = ?',
                args: [link.rows[0].credential_id]
            });
        }

        // Delete assignments
        await db.execute({
            sql: 'DELETE FROM exam_assignments WHERE exam_id = ? AND resident_id = ?',
            args: [examId, residentId]
        });

        // Delete the link
        await db.execute({
            sql: 'DELETE FROM exam_residents WHERE exam_id = ? AND resident_id = ?',
            args: [examId, residentId]
        });

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to remove resident' });
    }
});

// === ROOM ASSIGNMENTS ===

// Get room assignments for an exam
router.get('/exams/:examId/room-assignments', requireAdmin, async (req, res) => {
    try {
        const result = await db.execute({
            sql: `SELECT era.id, era.room_number, era.resident_id,
                         r.name as resident_name, r.pgy_level
                  FROM exam_room_assignments era
                  JOIN residents r ON era.resident_id = r.id
                  WHERE era.exam_id = ?
                  ORDER BY era.room_number, r.name`,
            args: [parseInt(req.params.examId)]
        });

        // Get rooms that have files
        const rooms = await db.execute({
            sql: `SELECT DISTINCT room_number FROM files
                  WHERE exam_id = ? AND room_number IS NOT NULL
                  ORDER BY room_number`,
            args: [parseInt(req.params.examId)]
        });

        res.json({
            assignments: result.rows,
            rooms: rooms.rows.map(r => r.room_number)
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load room assignments' });
    }
});

// Assign residents to a room (auto-logs question history)
router.post('/exams/:examId/room-assignments', requireAdmin, async (req, res) => {
    const examId = parseInt(req.params.examId);
    const { residentIds, roomNumber } = req.body;

    if (!residentIds?.length || !roomNumber) {
        return res.status(400).json({ error: 'Select residents and a room number' });
    }

    try {
        let assigned = 0;
        for (const resId of residentIds) {
            try {
                await db.execute({
                    sql: 'INSERT OR IGNORE INTO exam_room_assignments (exam_id, resident_id, room_number) VALUES (?, ?, ?)',
                    args: [examId, parseInt(resId), parseInt(roomNumber)]
                });
                assigned++;
            } catch (e) { continue; }

            // Auto-log question history for all stems in this room
            const roomFiles = await db.execute({
                sql: `SELECT f.display_name, r.id as repo_stem_id, r.display_name as stem_name, r.specialty
                      FROM files f
                      LEFT JOIN repository r ON f.public_id = r.public_id AND r.category = 'stem'
                      WHERE f.exam_id = ? AND f.room_number = ?`,
                args: [examId, parseInt(roomNumber)]
            });

            const resident = await db.execute({
                sql: 'SELECT name FROM residents WHERE id = ?',
                args: [parseInt(resId)]
            });
            const resName = resident.rows[0]?.name || 'Unknown';

            for (const file of roomFiles.rows) {
                if (!file.repo_stem_id) continue;
                const existing = await db.execute({
                    sql: 'SELECT id FROM question_history WHERE resident_id = ? AND exam_id = ? AND repository_stem_id = ?',
                    args: [parseInt(resId), examId, file.repo_stem_id]
                });
                if (existing.rows.length === 0) {
                    await db.execute({
                        sql: `INSERT INTO question_history
                              (resident_id, resident_name, exam_id, repository_stem_id, stem_display_name, specialty, room_number, recorded_by)
                              VALUES (?, ?, ?, ?, ?, ?, ?, 'auto-room')`,
                        args: [parseInt(resId), resName, examId, file.repo_stem_id, file.stem_name, file.specialty, parseInt(roomNumber)]
                    });
                }
            }
        }
        res.json({ success: true, assigned });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to assign rooms' });
    }
});

// Remove a room assignment
router.delete('/exams/:examId/room-assignments/:id', requireAdmin, async (req, res) => {
    try {
        await db.execute({
            sql: 'DELETE FROM exam_room_assignments WHERE id = ? AND exam_id = ?',
            args: [parseInt(req.params.id), parseInt(req.params.examId)]
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to remove room assignment' });
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

// Add files from repository to exam (with optional room number)
router.post('/files/from-repository', requireAdmin, async (req, res) => {
    const { examId, repositoryIds, roomNumber } = req.body;

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
                // Set item_type to the repository category so we can filter scenarios from residents
                const result = await db.execute({
                    sql: 'INSERT INTO files (exam_id, display_name, filename, file_url, public_id, file_type, sort_order, room_number, item_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    args: [parseInt(examId), repoFile.display_name, repoFile.filename, repoFile.file_url, repoFile.public_id, repoFile.file_type, sortOrder, roomNumber ? parseInt(roomNumber) : null, repoFile.category || null]
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
                            sql: 'INSERT INTO files (exam_id, display_name, filename, file_url, public_id, file_type, sort_order, room_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                            args: [parseInt(examId), img.display_name, img.filename, img.file_url, img.public_id, img.file_type, sortOrder, roomNumber ? parseInt(roomNumber) : null]
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

        res.json({ success: true, added: added.length, files: added });
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

// Debug endpoint - temporary, remove after fixing
router.get('/repository/debug', async (req, res) => {
    try {
        const count = await db.execute('SELECT COUNT(*) as cnt FROM repository');
        const sample = await db.execute('SELECT id, display_name, category FROM repository LIMIT 3');
        res.json({ count: count.rows[0]?.cnt, sample: sample.rows, ok: true });
    } catch (err) {
        res.json({ error: err.message, ok: false });
    }
});

router.get('/repository/list', requireAdmin, async (req, res) => {
    try {
        const result = await db.execute(
            'SELECT id, display_name, filename, file_url, public_id, file_type, category, related_stem_id, specialty, created_at FROM repository ORDER BY category, specialty, display_name'
        );
        const rows = result.rows || [];
        console.log(`Repository list: returning ${rows.length} rows`);
        return res.json(rows);
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

// === FACULTY DIRECTORY ===

router.get('/faculty', requireAdmin, async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM faculty WHERE status = 'active' ORDER BY SUBSTR(name, INSTR(name, ' ') + 1)");
        res.json({ faculty: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load faculty' });
    }
});

router.post('/faculty', requireAdmin, async (req, res) => {
    const { name, email } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    try {
        await db.execute({ sql: 'INSERT INTO faculty (name, email) VALUES (?, ?)', args: [name, email || null] });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to add faculty' });
    }
});

router.delete('/faculty/:id', requireAdmin, async (req, res) => {
    try {
        await db.execute({ sql: "UPDATE faculty SET status = 'inactive' WHERE id = ?", args: [parseInt(req.params.id)] });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to remove faculty' });
    }
});

// === EXAMINER MANAGEMENT ===

// Get examiners for an exam
router.get('/exams/:id/examiners', requireAdmin, async (req, res) => {
    try {
        const result = await db.execute({
            sql: 'SELECT * FROM examiners WHERE exam_id = ? ORDER BY room_number, name',
            args: [parseInt(req.params.id)]
        });
        res.json({ examiners: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load examiners' });
    }
});

// Create examiner for an exam (from faculty directory or manual)
router.post('/exams/:id/examiners', requireAdmin, async (req, res) => {
    const examId = parseInt(req.params.id);
    let { name, roomNumber, email, facultyId } = req.body;

    // If facultyId provided, look up name and email from faculty table
    if (facultyId) {
        const fac = await db.execute({ sql: 'SELECT * FROM faculty WHERE id = ?', args: [parseInt(facultyId)] });
        if (fac.rows[0]) {
            name = fac.rows[0].name;
            email = fac.rows[0].email;
        }
    }

    if (!name) return res.status(400).json({ error: 'Examiner name is required' });

    try {
        // Generate username and password
        const username = `EX${examId}R${roomNumber || 0}_${name.split(/[\s,]+/)[0].toUpperCase()}`;
        const password = generatePassword();

        await db.execute({
            sql: 'INSERT INTO examiners (exam_id, name, username, password, room_number, email) VALUES (?, ?, ?, ?, ?, ?)',
            args: [examId, name, username, password, roomNumber ? parseInt(roomNumber) : null, email || null]
        });

        res.json({ success: true, username, password });
    } catch (err) {
        if (err.message?.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Username already exists. Try a different name.' });
        }
        console.error(err);
        res.status(500).json({ error: 'Failed to create examiner' });
    }
});

// Delete examiner
router.delete('/exams/:examId/examiners/:id', requireAdmin, async (req, res) => {
    try {
        await db.execute({ sql: 'DELETE FROM examiners WHERE id = ?', args: [parseInt(req.params.id)] });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete examiner' });
    }
});

// === EXAMINER SCORING ===

router.get('/scoring', requireAdmin, (req, res) => {
    res.sendFile('admin/scoring.html', { root: './views' });
});

// Get scoring data for an exam (residents + their assigned questions)
router.get('/scoring/:examId', requireAdmin, async (req, res) => {
    const examId = parseInt(req.params.examId);
    try {
        const exam = await db.execute({ sql: 'SELECT * FROM exams WHERE id = ?', args: [examId] });

        // Get residents in this exam
        const residents = await db.execute({
            sql: `SELECT DISTINCT r.id, r.name, r.pgy_level
                  FROM exam_residents er
                  JOIN residents r ON er.resident_id = r.id
                  WHERE er.exam_id = ?
                  ORDER BY r.name`,
            args: [examId]
        });

        // Get files for this exam
        const files = await db.execute({
            sql: `SELECT f.id, f.display_name, f.room_number, f.item_number,
                         r.id as repo_stem_id, r.specialty
                  FROM files f
                  LEFT JOIN repository r ON f.public_id = r.public_id AND r.category = 'stem'
                  WHERE f.exam_id = ?
                  ORDER BY f.room_number, f.sort_order, f.id`,
            args: [examId]
        });

        // Get existing scores
        const scores = await db.execute({
            sql: 'SELECT * FROM exam_scores WHERE exam_id = ? ORDER BY scored_at DESC',
            args: [examId]
        });

        res.json({
            exam: exam.rows[0],
            residents: residents.rows,
            files: files.rows,
            scores: scores.rows
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load scoring data' });
    }
});

// Submit scores
router.post('/scoring/submit', requireAdmin, async (req, res) => {
    const { examId, scores, examinerName } = req.body;

    if (!examId || !scores || !scores.length) {
        return res.status(400).json({ error: 'Exam and scores are required' });
    }

    try {
        let saved = 0;
        for (const s of scores) {
            // Check for existing score (update if exists)
            const existing = await db.execute({
                sql: 'SELECT id FROM exam_scores WHERE exam_id = ? AND resident_id = ? AND file_id = ?',
                args: [parseInt(examId), parseInt(s.residentId), s.fileId ? parseInt(s.fileId) : null]
            });

            if (existing.rows.length > 0) {
                await db.execute({
                    sql: `UPDATE exam_scores SET score = ?, comments = ?, examiner_name = ?, scored_at = CURRENT_TIMESTAMP
                          WHERE id = ?`,
                    args: [s.score, s.comments || null, examinerName || null, existing.rows[0].id]
                });
            } else {
                await db.execute({
                    sql: `INSERT INTO exam_scores (exam_id, resident_id, file_id, repository_stem_id, question_name, score, comments, examiner_name, room_number)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    args: [parseInt(examId), parseInt(s.residentId), s.fileId ? parseInt(s.fileId) : null,
                           s.repoStemId ? parseInt(s.repoStemId) : null,
                           s.questionName || 'Unknown', s.score, s.comments || null,
                           examinerName || null, s.roomNumber ? parseInt(s.roomNumber) : null]
                });
            }
            saved++;
        }
        res.json({ success: true, saved });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to save scores' });
    }
});

// Delete a score
router.delete('/scoring/:id', requireAdmin, async (req, res) => {
    try {
        await db.execute({ sql: 'DELETE FROM exam_scores WHERE id = ?', args: [parseInt(req.params.id)] });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete score' });
    }
});

// Get resident's longitudinal scores (all exams)
router.get('/scoring/resident/:id', requireAdmin, async (req, res) => {
    const residentId = parseInt(req.params.id);
    try {
        const resident = await db.execute({ sql: 'SELECT * FROM residents WHERE id = ?', args: [residentId] });

        const scores = await db.execute({
            sql: `SELECT es.*, e.name as exam_name, e.date as exam_date
                  FROM exam_scores es
                  JOIN exams e ON es.exam_id = e.id
                  WHERE es.resident_id = ?
                  ORDER BY e.date DESC, es.scored_at DESC`,
            args: [residentId]
        });

        // Summary stats
        const stats = await db.execute({
            sql: `SELECT score, COUNT(*) as cnt
                  FROM exam_scores WHERE resident_id = ? GROUP BY score`,
            args: [residentId]
        });

        res.json({
            resident: resident.rows[0],
            scores: scores.rows,
            stats: stats.rows
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load resident scores' });
    }
});

// Exam summary report for a resident
router.get('/scoring/report/:examId/:residentId', requireAdmin, async (req, res) => {
    const examId = parseInt(req.params.examId);
    const residentId = parseInt(req.params.residentId);
    try {
        const exam = await db.execute({ sql: 'SELECT * FROM exams WHERE id = ?', args: [examId] });
        const resident = await db.execute({ sql: 'SELECT * FROM residents WHERE id = ?', args: [residentId] });
        const scores = await db.execute({
            sql: `SELECT * FROM exam_scores WHERE exam_id = ? AND resident_id = ? ORDER BY room_number, scored_at`,
            args: [examId, residentId]
        });

        // All-time stats for context
        const allStats = await db.execute({
            sql: 'SELECT score, COUNT(*) as cnt FROM exam_scores WHERE resident_id = ? GROUP BY score',
            args: [residentId]
        });

        res.json({
            exam: exam.rows[0],
            resident: resident.rows[0],
            scores: scores.rows,
            allTimeStats: allStats.rows
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate report' });
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

// === EMAIL NOTIFICATIONS ===

// Send emails to all examiners for an exam
router.post('/exams/:id/email-examiners', requireAdmin, async (req, res) => {
    if (!emailModule) return res.status(500).json({ error: 'Email module not configured. Check that nodemailer is installed and GMAIL_USER/GMAIL_APP_PASSWORD are set.' });

    const examId = parseInt(req.params.id);
    try {
        const exam = await db.execute({ sql: 'SELECT * FROM exams WHERE id = ?', args: [examId] });
        if (!exam.rows[0]) return res.status(404).json({ error: 'Exam not found' });

        const examiners = await db.execute({
            sql: "SELECT * FROM examiners WHERE exam_id = ? AND email IS NOT NULL AND email != ''",
            args: [examId]
        });

        if (examiners.rows.length === 0) {
            return res.status(400).json({ error: 'No examiners with email addresses found' });
        }

        // Get all residents for this exam with credentials
        const residents = await db.execute({
            sql: `SELECT r.id, r.name, r.pgy_level, c.username, c.password
                  FROM exam_residents er
                  JOIN residents r ON er.resident_id = r.id
                  LEFT JOIN credentials c ON er.credential_id = c.id
                  WHERE er.exam_id = ?
                  ORDER BY r.pgy_level DESC, r.name`,
            args: [examId]
        });

        let sent = 0;
        let errors = [];

        for (const examiner of examiners.rows) {
            try {
                await emailModule.sendExaminerEmail({
                    examinerName: examiner.name,
                    examinerEmail: examiner.email,
                    username: examiner.username,
                    password: examiner.password,
                    examName: exam.rows[0].name,
                    examDate: exam.rows[0].date,
                    roomNumber: examiner.room_number,
                    examinees: residents.rows,
                    siteUrl: req.protocol + '://' + req.get('host')
                });
                sent++;
            } catch (err) {
                errors.push(`${examiner.name}: ${err.message}`);
            }
        }

        res.json({ success: true, sent, errors });
    } catch (err) {
        console.error('Email examiner error:', err);
        res.status(500).json({ error: 'Failed to send examiner emails: ' + err.message });
    }
});

// Send emails to all residents for an exam
router.post('/exams/:id/email-residents', requireAdmin, async (req, res) => {
    if (!emailModule) return res.status(500).json({ error: 'Email module not configured. Check that nodemailer is installed and GMAIL_USER/GMAIL_APP_PASSWORD are set.' });

    const examId = parseInt(req.params.id);
    try {
        const exam = await db.execute({ sql: 'SELECT * FROM exams WHERE id = ?', args: [examId] });
        if (!exam.rows[0]) return res.status(404).json({ error: 'Exam not found' });

        // Get residents with credentials and emails
        const residents = await db.execute({
            sql: `SELECT r.id, r.name, r.pgy_level, r.email, c.username, c.password
                  FROM exam_residents er
                  JOIN residents r ON er.resident_id = r.id
                  LEFT JOIN credentials c ON er.credential_id = c.id
                  WHERE er.exam_id = ? AND r.email IS NOT NULL AND r.email != ''`,
            args: [examId]
        });

        if (residents.rows.length === 0) {
            return res.status(400).json({ error: 'No residents with email addresses found. Add emails on the Question Tracker page.' });
        }

        let sent = 0;
        let errors = [];

        for (const resident of residents.rows) {
            try {
                await emailModule.sendResidentEmail({
                    residentName: resident.name,
                    residentEmail: resident.email,
                    username: resident.username,
                    password: resident.password,
                    examName: exam.rows[0].name,
                    examDate: exam.rows[0].date,
                    startTime: exam.rows[0].start_time,
                    siteUrl: req.protocol + '://' + req.get('host')
                });
                sent++;
            } catch (err) {
                errors.push(`${resident.name}: ${err.message}`);
            }
        }

        res.json({ success: true, sent, errors });
    } catch (err) {
        console.error('Email resident error:', err);
        res.status(500).json({ error: 'Failed to send resident emails: ' + err.message });
    }
});

// Verify email config
router.get('/email/verify', requireAdmin, async (req, res) => {
    if (!emailModule) return res.json({ configured: false, error: 'Email module not loaded' });
    const ok = await emailModule.verifyEmailConfig();
    res.json({ configured: ok });
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
