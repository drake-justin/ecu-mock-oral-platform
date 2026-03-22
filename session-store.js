const session = require('express-session');
const { db } = require('./database');

class TursoSessionStore extends session.Store {
    async get(sid, callback) {
        try {
            const result = await db.execute({
                sql: 'SELECT sess FROM sessions WHERE sid = ? AND expired > datetime(?)',
                args: [sid, new Date().toISOString()]
            });
            if (result.rows.length > 0) {
                const sess = JSON.parse(result.rows[0].sess);
                callback(null, sess);
            } else {
                callback(null, null);
            }
        } catch (err) {
            callback(err);
        }
    }

    async set(sid, sess, callback) {
        try {
            const maxAge = sess.cookie?.maxAge || 86400000; // 24 hours default
            const expired = new Date(Date.now() + maxAge).toISOString();
            const sessStr = JSON.stringify(sess);

            await db.execute({
                sql: `INSERT INTO sessions (sid, sess, expired) VALUES (?, ?, ?)
                      ON CONFLICT(sid) DO UPDATE SET sess = ?, expired = ?`,
                args: [sid, sessStr, expired, sessStr, expired]
            });
            callback(null);
        } catch (err) {
            callback(err);
        }
    }

    async destroy(sid, callback) {
        try {
            await db.execute({ sql: 'DELETE FROM sessions WHERE sid = ?', args: [sid] });
            if (callback) callback(null);
        } catch (err) {
            if (callback) callback(err);
        }
    }

    async touch(sid, sess, callback) {
        try {
            const maxAge = sess.cookie?.maxAge || 86400000;
            const expired = new Date(Date.now() + maxAge).toISOString();
            await db.execute({
                sql: 'UPDATE sessions SET expired = ? WHERE sid = ?',
                args: [expired, sid]
            });
            if (callback) callback(null);
        } catch (err) {
            if (callback) callback(err);
        }
    }

    // Clean up expired sessions periodically
    async cleanup() {
        try {
            await db.execute({
                sql: 'DELETE FROM sessions WHERE expired < datetime(?)',
                args: [new Date().toISOString()]
            });
        } catch (err) {
            console.error('Session cleanup error:', err.message);
        }
    }
}

module.exports = TursoSessionStore;
