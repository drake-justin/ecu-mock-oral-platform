const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireExaminee } = require('../middleware/auth');

// Exam portal page
router.get('/', requireExaminee, (req, res) => {
    res.sendFile('exam.html', { root: './views' });
});

// Get exam data for current examinee
router.get('/data', requireExaminee, async (req, res) => {
    try {
        const examId = req.session.examinee.examId;

        const examResult = await db.execute({
            sql: 'SELECT * FROM exams WHERE id = ?',
            args: [examId]
        });
        const exam = examResult.rows[0];

        const filesResult = await db.execute({
            sql: 'SELECT * FROM files WHERE exam_id = ? ORDER BY sort_order, id',
            args: [examId]
        });

        res.json({
            examName: exam.name,
            files: filesResult.rows.map(f => ({
                id: f.id,
                displayName: f.display_name,
                fileType: f.file_type,
                fileUrl: f.file_url,
                roomNumber: f.room_number,
                itemNumber: f.item_number,
                itemType: f.item_type
            }))
        });
    } catch (err) {
        console.error('Error loading exam data:', err);
        res.status(500).json({ error: 'Failed to load exam data' });
    }
});

// Redirect to file URL (Cloudinary)
router.get('/file/:id', requireExaminee, async (req, res) => {
    try {
        const fileId = parseInt(req.params.id);

        const result = await db.execute({
            sql: 'SELECT * FROM files WHERE id = ?',
            args: [fileId]
        });
        const file = result.rows[0];

        if (!file) {
            return res.status(404).send('File not found');
        }

        // Verify file belongs to examinee's exam
        if (file.exam_id !== req.session.examinee.examId) {
            return res.status(403).send('Access denied');
        }

        // Redirect to Cloudinary URL
        if (file.file_url) {
            res.redirect(file.file_url);
        } else {
            res.status(404).send('File URL not found');
        }
    } catch (err) {
        console.error('Error serving file:', err);
        res.status(500).send('Error loading file');
    }
});

module.exports = router;
