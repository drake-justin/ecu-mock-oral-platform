const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { adminQueries, credentialQueries, examQueries } = require('../database');
const { rateLimiter, recordLoginAttempt, clearLoginAttempts } = require('../middleware/auth');

// Examinee login page
router.get('/', (req, res) => {
    if (req.session.examinee) {
        return res.redirect('/exam');
    }
    res.sendFile('login.html', { root: './views' });
});

// Examinee login POST
router.post('/login', rateLimiter, (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    const credential = credentialQueries.findByUsername.get(username.toUpperCase());

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
    const exam = examQueries.findById.get(credential.exam_id);
    if (!exam || !exam.is_active) {
        return res.status(403).json({ error: 'This exam is not currently active' });
    }

    // Mark credential as used
    credentialQueries.markUsed.run(credential.id);

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
router.post('/admin/login', rateLimiter, (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    const admin = adminQueries.findByUsername.get(username);

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
});

// Admin logout
router.post('/admin/logout', (req, res) => {
    req.session.destroy((err) => {
        res.redirect('/admin/login');
    });
});

module.exports = router;
