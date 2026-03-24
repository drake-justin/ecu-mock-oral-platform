const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const crypto = require('crypto');
const path = require('path');
const { initializeDatabase } = require('./database');
const TursoSessionStore = require('./session-store');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy (required for Railway/Render/etc)
app.set('trust proxy', 1);

// Security headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https://res.cloudinary.com"],
            connectSrc: ["'self'"],
            fontSrc: ["'self'"],
            objectSrc: ["'none'"],
            frameSrc: ["'self'", "https://res.cloudinary.com"],
        }
    },
    crossOriginEmbedderPolicy: false, // Allow Cloudinary embeds
}));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Generate a random session secret if none provided (warn in production)
const sessionSecret = process.env.SESSION_SECRET || (() => {
    const generated = crypto.randomBytes(32).toString('hex');
    console.warn('WARNING: No SESSION_SECRET set. Using a random secret — sessions will not survive restarts. Set SESSION_SECRET in your environment.');
    return generated;
})();

// Session configuration with database-backed store (survives redeploys)
const sessionStore = new TursoSessionStore();
app.use(session({
    store: sessionStore,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'strict',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Clean up expired sessions every hour
setInterval(() => sessionStore.cleanup(), 60 * 60 * 1000);

// CSRF protection: verify Origin/Referer on state-changing requests
// Combined with sameSite: 'strict' cookies, this provides strong CSRF defense
app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

    const host = req.get('host');
    const origin = req.get('origin');
    const referer = req.get('referer');

    // Helper: check if a URL's host matches the request host
    function hostMatches(url) {
        try { return new URL(url).host === host; } catch { return false; }
    }

    // Allow if origin or referer matches host
    if (origin && hostMatches(origin)) return next();
    if (referer && hostMatches(referer)) return next();

    // Allow requests with neither header (same-origin nav, curl, etc.)
    // sameSite: 'strict' cookie already blocks cross-origin cookie sending
    if (!origin && !referer) return next();

    return res.status(403).json({ error: 'Request blocked — origin mismatch' });
});

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
