const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { db } = require('../database');
const { rateLimiter, recordLoginAttempt, clearLoginAttempts } = require('../middleware/auth');

// Examinee login page
router.get('/', (req, res) => {
    if (req.session.examinee) {
        return res.redirect('/exam');
    }
    res.sendFile('login.html', { root: './views' });
});

// Examinee login POST
router.post('/login', rateLimiter, async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    try {
        const result = await db.execute({
            sql: `SELECT c.*, e.name as exam_name FROM credentials c
                  JOIN exams e ON c.exam_id = e.id
                  WHERE c.username = ?`,
            args: [username.toUpperCase()]
        });

        const credential = result.rows[0];

        if (!credential) {
            recordLoginAttempt(req.ip);
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        if (credential.password !== password) {
            recordLoginAttempt(req.ip);
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        if (credential.is_used) {
            return res.status(403).json({ error: 'These credentials have already been used' });
        }

        // Check if exam is active
        const examResult = await db.execute({
            sql: 'SELECT * FROM exams WHERE id = ?',
            args: [credential.exam_id]
        });
        const exam = examResult.rows[0];

        if (!exam || !exam.is_active) {
            return res.status(403).json({ error: 'This exam is not currently active' });
        }

        // Mark credential as used
        await db.execute({
            sql: 'UPDATE credentials SET is_used = 1, used_at = CURRENT_TIMESTAMP WHERE id = ?',
            args: [credential.id]
        });

        // Clear login attempts on success
        clearLoginAttempts(req.ip);

        // Create session
        req.session.examinee = {
            id: credential.id,
            username: credential.username,
            examId: credential.exam_id,
            examName: credential.exam_name
        };

        res.json({ success: true, redirect: '/exam' });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'An error occurred' });
    }
});

// Examinee logout
router.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        res.redirect('/');
    });
});

// Admin login page
router.get('/admin/login', (req, res) => {
    if (req.session.admin) {
        return res.redirect('/admin');
    }
    res.sendFile('admin/login.html', { root: './views' });
});

// Admin login POST
router.post('/admin/login', rateLimiter, async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    try {
        const result = await db.execute({
            sql: 'SELECT * FROM admins WHERE username = ?',
            args: [username]
        });

        const admin = result.rows[0];

        if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
            recordLoginAttempt(req.ip);
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        clearLoginAttempts(req.ip);

        req.session.admin = {
            id: admin.id,
            username: admin.username
        };

        res.json({ success: true, redirect: '/admin' });
    } catch (err) {
        console.error('Admin login error:', err);
        res.status(500).json({ error: 'An error occurred' });
    }
});

// Admin logout
router.post('/admin/logout', (req, res) => {
    req.session.destroy((err) => {
        res.redirect('/admin/login');
    });
});

module.exports = router;
