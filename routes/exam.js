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

        // Check if this examinee has room assignments
        const credId = req.session.examinee.id;
        const credResult = await db.execute({
            sql: 'SELECT resident_id FROM credentials WHERE id = ?',
            args: [credId]
        });
        const residentId = credResult.rows[0]?.resident_id;

        let filesResult;
        if (residentId) {
            // Check if room assignments exist for this resident
            const rooms = await db.execute({
                sql: 'SELECT room_number FROM exam_room_assignments WHERE exam_id = ? AND resident_id = ?',
                args: [examId, residentId]
            });

            if (rooms.rows.length > 0) {
                // Serve files for assigned rooms only, exclude scenarios (examiner-only)
                const roomNums = rooms.rows.map(r => r.room_number);
                const placeholders = roomNums.map(() => '?').join(',');
                filesResult = await db.execute({
                    sql: `SELECT * FROM files WHERE exam_id = ? AND room_number IN (${placeholders})
                          AND (item_type IS NULL OR item_type != 'scenario')
                          ORDER BY room_number, sort_order, id`,
                    args: [examId, ...roomNums]
                });
            } else {
                // No room assignments - serve all exam files except scenarios
                filesResult = await db.execute({
                    sql: "SELECT * FROM files WHERE exam_id = ? AND (item_type IS NULL OR item_type != 'scenario') ORDER BY sort_order, id",
                    args: [examId]
                });
            }
        } else {
            // No resident link - serve all exam files except scenarios
            filesResult = await db.execute({
                sql: "SELECT * FROM files WHERE exam_id = ? AND (item_type IS NULL OR item_type != 'scenario') ORDER BY sort_order, id",
                args: [examId]
            });
        }

        // Mask file names so examinees can't see the diagnosis
        // Stems → "Question 1", "Question 2", etc.
        // Clinical images → "Image A", "Image B", etc.
        let questionNum = 0;
        let imageLetterCode = 65; // ASCII 'A'
        const maskedFiles = filesResult.rows.map(f => {
            let maskedName = f.display_name;
            const itemType = f.item_type || '';

            if (itemType === 'stem') {
                questionNum++;
                maskedName = `Question ${questionNum}`;
            } else if (itemType === 'clinical_image') {
                maskedName = `Image ${String.fromCharCode(imageLetterCode)}`;
                imageLetterCode++;
            }

            return {
                id: f.id,
                displayName: maskedName,
                fileType: f.file_type,
                fileUrl: f.file_url,
                roomNumber: f.room_number,
                itemNumber: f.item_number,
                itemType: itemType
            };
        });

        res.json({
            examName: exam.name,
            files: maskedFiles
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
