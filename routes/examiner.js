const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireExaminer, rateLimiter, recordLoginAttempt, clearLoginAttempts } = require('../middleware/auth');

// Examiner login page
router.get('/login', (req, res) => {
    res.sendFile('examiner/login.html', { root: './views' });
});

// Examiner login
router.post('/login', rateLimiter, async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    try {
        const result = await db.execute({
            sql: `SELECT ex.*, e.name as exam_name, e.date as exam_date, e.is_active
                  FROM examiners ex
                  JOIN exams e ON ex.exam_id = e.id
                  WHERE ex.username = ?`,
            args: [username]
        });

        const examiner = result.rows[0];

        if (!examiner || examiner.password !== password) {
            recordLoginAttempt(req.ip);
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Examiners can access before the exam is active (to review scenarios)
        // But credentials expire the day after the exam date
        if (examiner.exam_date) {
            const examDate = new Date(examiner.exam_date);
            const dayAfter = new Date(examDate);
            dayAfter.setDate(dayAfter.getDate() + 1);
            dayAfter.setHours(23, 59, 59);
            if (new Date() > dayAfter) {
                return res.status(403).json({ error: 'This exam has ended. Examiner access expired.' });
            }
        }

        clearLoginAttempts(req.ip);

        req.session.examiner = {
            id: examiner.id,
            name: examiner.name,
            examId: examiner.exam_id,
            examName: examiner.exam_name,
            roomNumber: examiner.room_number
        };

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Examiner logout
router.post('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/examiner/login');
});

// Examiner portal
router.get('/', requireExaminer, (req, res) => {
    res.sendFile('examiner/portal.html', { root: './views' });
});

// Get examiner's data: their questions, examinees, and existing scores
router.get('/data', requireExaminer, async (req, res) => {
    const { examId, roomNumber, id: examinerId, name: examinerName } = req.session.examiner;

    try {
        // Get exam info
        const exam = await db.execute({
            sql: 'SELECT * FROM exams WHERE id = ?',
            args: [examId]
        });

        // Get files for this exam with repo linkage for grouping
        let filesQuery, filesArgs;
        if (roomNumber) {
            filesQuery = `SELECT f.*, r.id as repo_id, r.specialty, r.category as repo_category, r.related_stem_id as repo_related_stem_id
                          FROM files f
                          LEFT JOIN repo_files r ON f.public_id = r.public_id
                          WHERE f.exam_id = ? AND (f.room_number = ? OR f.room_number IS NULL)
                          ORDER BY f.sort_order, f.id`;
            filesArgs = [examId, roomNumber];
        } else {
            filesQuery = `SELECT f.*, r.id as repo_id, r.specialty, r.category as repo_category, r.related_stem_id as repo_related_stem_id
                          FROM files f
                          LEFT JOIN repo_files r ON f.public_id = r.public_id
                          WHERE f.exam_id = ?
                          ORDER BY f.room_number, f.sort_order, f.id`;
            filesArgs = [examId];
        }
        const files = await db.execute({ sql: filesQuery, args: filesArgs });

        // Get residents assigned to this exam
        const residents = await db.execute({
            sql: `SELECT r.id, r.name, r.pgy_level, c.username, c.password, c.id as credential_id, c.is_used
                  FROM exam_residents er
                  JOIN residents r ON er.resident_id = r.id
                  LEFT JOIN credentials c ON er.credential_id = c.id
                  WHERE er.exam_id = ?
                  ORDER BY r.pgy_level DESC, r.name`,
            args: [examId]
        });

        // Get existing scores by this examiner for this exam
        const scores = await db.execute({
            sql: 'SELECT * FROM exam_scores WHERE exam_id = ? AND examiner_name = ?',
            args: [examId, examinerName]
        });

        res.json({
            exam: exam.rows[0],
            examinerName,
            roomNumber,
            files: files.rows,
            residents: residents.rows,
            scores: scores.rows
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load examiner data' });
    }
});

// Submit scores from examiner portal
router.post('/score', requireExaminer, async (req, res) => {
    const { scores } = req.body;
    const { examId, name: examinerName } = req.session.examiner;

    if (!scores || !scores.length) {
        return res.status(400).json({ error: 'No scores to submit' });
    }

    try {
        let saved = 0;
        for (const s of scores) {
            const existing = await db.execute({
                sql: 'SELECT id FROM exam_scores WHERE exam_id = ? AND resident_id = ? AND file_id = ? AND examiner_name = ?',
                args: [examId, parseInt(s.residentId), s.fileId ? parseInt(s.fileId) : null, examinerName]
            });

            if (existing.rows.length > 0) {
                await db.execute({
                    sql: 'UPDATE exam_scores SET score = ?, comments = ?, scored_at = CURRENT_TIMESTAMP WHERE id = ?',
                    args: [s.score, s.comments || null, existing.rows[0].id]
                });
            } else {
                await db.execute({
                    sql: `INSERT INTO exam_scores (exam_id, resident_id, file_id, repository_stem_id, question_name, score, comments, examiner_name, room_number)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    args: [examId, parseInt(s.residentId), s.fileId ? parseInt(s.fileId) : null,
                           s.repoStemId ? parseInt(s.repoStemId) : null,
                           s.questionName || 'Unknown', s.score, s.comments || null,
                           examinerName, s.roomNumber ? parseInt(s.roomNumber) : null]
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

// Remove a clinical image from the exam (examiner can do this)
router.post('/remove-file/:fileId', requireExaminer, async (req, res) => {
    const fileId = parseInt(req.params.fileId);
    const examId = req.session.examiner.examId;
    try {
        // Verify file belongs to examiner's exam and is a clinical image
        const file = await db.execute({
            sql: 'SELECT * FROM files WHERE id = ? AND exam_id = ?',
            args: [fileId, examId]
        });
        if (!file.rows[0]) return res.status(404).json({ error: 'File not found' });
        if (file.rows[0].item_type !== 'clinical_image') {
            return res.status(403).json({ error: 'Can only remove clinical images' });
        }
        await db.execute({ sql: 'DELETE FROM files WHERE id = ?', args: [fileId] });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to remove file' });
    }
});

// Reset an examinee's credential so they can log in again
router.post('/reset-credential/:credentialId', requireExaminer, async (req, res) => {
    const credId = parseInt(req.params.credentialId);
    const examId = req.session.examiner.examId;

    try {
        // Verify this credential belongs to the examiner's exam
        const cred = await db.execute({
            sql: 'SELECT * FROM credentials WHERE id = ? AND exam_id = ?',
            args: [credId, examId]
        });

        if (!cred.rows[0]) {
            return res.status(404).json({ error: 'Credential not found for this exam' });
        }

        await db.execute({
            sql: 'UPDATE credentials SET is_used = 0, used_at = NULL WHERE id = ?',
            args: [credId]
        });

        res.json({ success: true, name: cred.rows[0].examinee_name });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to reset credential' });
    }
});

module.exports = router;
