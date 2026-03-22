const express = require('express');
const session = require('express-session');
const path = require('path');
const { initializeDatabase } = require('./database');
const TursoSessionStore = require('./session-store');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy (required for Railway/Render/etc)
app.set('trust proxy', 1);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session configuration with database-backed store (survives redeploys)
const sessionStore = new TursoSessionStore();
app.use(session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || 'ecu-mock-oral-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Clean up expired sessions every hour
setInterval(() => sessionStore.cleanup(), 60 * 60 * 1000);

// Routes
const authRoutes = require('./routes/auth');
const examRoutes = require('./routes/exam');
const adminRoutes = require('./routes/admin');
const examinerRoutes = require('./routes/examiner');

app.use('/', authRoutes);
app.use('/exam', examRoutes);
app.use('/admin', adminRoutes);
app.use('/examiner', examinerRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

// Initialize database and start server
async function start() {
    try {
        await initializeDatabase();
        app.listen(PORT, () => {
            console.log(`ECU Mock Oral Platform running on http://localhost:${PORT}`);
            console.log(`Admin panel: http://localhost:${PORT}/admin/login`);
        });
    } catch (err) {
        console.error('Failed to initialize database:', err);
        process.exit(1);
    }
}

start();
