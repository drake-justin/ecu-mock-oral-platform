// Authentication middleware

// Check if user is authenticated as examinee
function requireExaminee(req, res, next) {
    if (req.session && req.session.examinee) {
        return next();
    }
    res.redirect('/');
}

// Check if user is authenticated as admin
function requireAdmin(req, res, next) {
    if (req.session && req.session.admin) {
        return next();
    }
    res.redirect('/admin/login');
}

// Rate limiting for login attempts
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_TIME = 15 * 60 * 1000; // 15 minutes

function rateLimiter(req, res, next) {
    const ip = req.ip;
    const now = Date.now();

    if (loginAttempts.has(ip)) {
        const attempts = loginAttempts.get(ip);

        // Clean up old attempts
        const recentAttempts = attempts.filter(time => now - time < LOCKOUT_TIME);

        if (recentAttempts.length >= MAX_ATTEMPTS) {
            const oldestAttempt = Math.min(...recentAttempts);
            const unlockTime = Math.ceil((LOCKOUT_TIME - (now - oldestAttempt)) / 1000 / 60);
            return res.status(429).json({
                error: `Too many login attempts. Please try again in ${unlockTime} minutes.`
            });
        }

        loginAttempts.set(ip, recentAttempts);
    }

    next();
}

function recordLoginAttempt(ip) {
    const now = Date.now();
    if (loginAttempts.has(ip)) {
        loginAttempts.get(ip).push(now);
    } else {
        loginAttempts.set(ip, [now]);
    }
}

function clearLoginAttempts(ip) {
    loginAttempts.delete(ip);
}

module.exports = {
    requireExaminee,
    requireAdmin,
    rateLimiter,
    recordLoginAttempt,
    clearLoginAttempts
};
