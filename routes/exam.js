const express = require('express');
const path = require('path');
const router = express.Router();
const { fileQueries, examQueries } = require('../database');
const { requireExaminee } = require('../middleware/auth');

// Exam portal page
router.get('/', requireExaminee, (req, res) => {
    res.sendFile('exam.html', { root: './views' });
});

// Get exam data for current examinee
router.get('/data', requireExaminee, (req, res) => {
    const examId = req.session.examinee.examId;
    const exam = examQueries.findById.get(examId);
    const files = fileQueries.findByExam.all(examId);

    res.json({
        examName: exam.name,
        files: files.map(f => ({
            id: f.id,
            displayName: f.display_name,
            fileType: f.file_type
        }))
    });
});

// View a specific file
router.get('/file/:id', requireExaminee, (req, res) => {
    const fileId = parseInt(req.params.id);
    const file = fileQueries.findById.get(fileId);

    if (!file) {
        return res.status(404).send('File not found');
    }

    // Verify file belongs to examinee's exam
    if (file.exam_id !== req.session.examinee.examId) {
        return res.status(403).send('Access denied');
    }

    const filePath = path.join(__dirname, '..', 'uploads', file.filename);
    res.sendFile(filePath);
});

module.exports = router;
