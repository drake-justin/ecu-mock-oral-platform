const nodemailer = require('nodemailer');

// Create Gmail transporter
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
    }
});

const SITE_URL = process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL || 'https://ecu-mock-oral-platform.onrender.com';
const FROM = `"ECU Mock Oral Platform" <${process.env.GMAIL_USER}>`;

// HTML escape helper to prevent injection in emails
function esc(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Send email to an examiner with their credentials, examinees, and exam details
async function sendExaminerEmail({ examinerName, examinerEmail, username, password, examName, examDate, roomNumber, examinees, siteUrl }) {
    const url = siteUrl || SITE_URL;

    const html = `
        <div style="font-family: Calibri, Arial, sans-serif; max-width: 650px; margin: 0 auto; font-size: 16px; line-height: 1.6;">
            <div style="background: #003366; color: white; padding: 25px; text-align: center;">
                <h1 style="margin: 0; font-size: 26px;">ECU Mock Oral Examination</h1>
                <p style="margin: 8px 0 0; opacity: 0.8; font-size: 18px;">Examiner Assignment</p>
            </div>
            <div style="padding: 30px; border: 1px solid #ddd; border-top: none;">
                <p style="font-size: 18px;">Dear Dr. ${esc(examinerName.split(',')[0].split(' ').pop())},</p>
                <p style="font-size: 16px;">You have been assigned as an examiner for the upcoming mock oral examination. You may log in at any time before the exam to review your question scenarios.</p>

                <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
                    <h3 style="color: #003366; margin: 0 0 12px; font-size: 20px;">Exam Details</h3>
                    <p style="margin: 6px 0; font-size: 16px;"><strong>Exam:</strong> ${esc(examName)}</p>
                    <p style="margin: 6px 0; font-size: 16px;"><strong>Date:</strong> ${esc(examDate || 'TBD')}</p>
                    ${roomNumber ? `<p style="margin: 6px 0; font-size: 16px;"><strong>Room:</strong> ${esc(roomNumber)}</p>` : ''}
                </div>

                <div style="background: #003366; color: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
                    <h3 style="margin: 0 0 12px; font-size: 20px;">Your Examiner Login</h3>
                    <p style="margin: 6px 0; font-size: 16px;">Website: <a href="${esc(url)}/examiner/login" style="color: #7cb9e8; font-size: 16px;">${esc(url)}/examiner/login</a></p>
                    <p style="margin: 6px 0; font-size: 18px;">Username: <strong style="font-size: 20px;">${esc(username)}</strong></p>
                    <p style="margin: 6px 0; font-size: 18px;">Password: <strong style="font-size: 20px;">${esc(password)}</strong></p>
                </div>

                ${examinees.length > 0 ? `
                <div style="background: #f0f4f8; padding: 20px; border-radius: 8px; margin: 20px 0;">
                    <h3 style="color: #003366; margin: 0 0 12px; font-size: 20px;">Your Examinees</h3>
                    <table style="width: 100%; border-collapse: collapse; font-size: 15px;">
                        <tr style="background: #003366; color: white;">
                            <th style="padding: 10px 12px; text-align: left;">Resident</th>
                            <th style="padding: 10px 12px; text-align: left;">PGY</th>
                            <th style="padding: 10px 12px; text-align: left;">Username</th>
                            <th style="padding: 10px 12px; text-align: left;">Password</th>
                        </tr>
                        ${examinees.map(e => `
                            <tr style="border-bottom: 1px solid #ddd;">
                                <td style="padding: 10px 12px; font-size: 15px;">${esc(e.name)}</td>
                                <td style="padding: 10px 12px; font-size: 15px;">PGY-${esc(e.pgy_level)}</td>
                                <td style="padding: 10px 12px; font-family: monospace; font-size: 15px;">${esc(e.username)}</td>
                                <td style="padding: 10px 12px; font-family: monospace; font-size: 15px;">${esc(e.password)}</td>
                            </tr>
                        `).join('')}
                    </table>
                </div>` : ''}

                <h3 style="color: #003366; font-size: 18px;">What to do:</h3>
                <ol style="font-size: 16px; line-height: 1.8;">
                    <li>Log in to the <strong>Examiner Portal</strong> before the exam to review your question scenarios and scoring rubric</li>
                    <li>On exam day, give each examinee their login credentials</li>
                    <li>After each session, use the <strong>Score & Feedback</strong> tab to grade the examinee</li>
                </ol>

                <p style="color: #888; font-size: 14px; margin-top: 25px; border-top: 1px solid #eee; padding-top: 15px;">
                    This is an automated message from the ECU Mock Oral Platform.<br>
                    Your examiner credentials remain active until the day after the exam.<br>
                    Questions? Contact the exam coordinator.
                </p>
            </div>
        </div>
    `;

    return transporter.sendMail({
        from: FROM,
        to: examinerEmail,
        subject: `Mock Oral Exam Assignment — ${String(examName).replace(/[<>]/g, '')}${examDate ? ` (${String(examDate).replace(/[<>]/g, '')})` : ''}`,
        html
    });
}

// Send email to a resident with their exam credentials
async function sendResidentEmail({ residentName, residentEmail, username, password, examName, examDate, startTime, siteUrl }) {
    const url = siteUrl || SITE_URL;

    const html = `
        <div style="font-family: Calibri, Arial, sans-serif; max-width: 650px; margin: 0 auto; font-size: 16px; line-height: 1.6;">
            <div style="background: #003366; color: white; padding: 25px; text-align: center;">
                <h1 style="margin: 0; font-size: 26px;">ECU Mock Oral Examination</h1>
                <p style="margin: 8px 0 0; opacity: 0.8; font-size: 18px;">Examinee Credentials</p>
            </div>
            <div style="padding: 30px; border: 1px solid #ddd; border-top: none;">
                <p style="font-size: 18px;">Dear ${esc(residentName.split(',')[0])},</p>
                <p style="font-size: 16px;">You have been registered for the upcoming mock oral examination. Below are your login credentials.</p>

                <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
                    <h3 style="color: #003366; margin: 0 0 12px; font-size: 20px;">Exam Details</h3>
                    <p style="margin: 6px 0; font-size: 16px;"><strong>Exam:</strong> ${esc(examName)}</p>
                    <p style="margin: 6px 0; font-size: 16px;"><strong>Date:</strong> ${esc(examDate || 'TBD')}</p>
                    ${startTime ? `<p style="margin: 6px 0; font-size: 16px;"><strong>Access opens:</strong> ${esc(startTime)}</p>` : ''}
                </div>

                <div style="background: #003366; color: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
                    <h3 style="margin: 0 0 12px; font-size: 20px;">Your Login Credentials</h3>
                    <p style="margin: 6px 0; font-size: 16px;">Website: <a href="${esc(url)}" style="color: #7cb9e8; font-size: 16px;">${esc(url)}</a></p>
                    <p style="margin: 6px 0; font-size: 18px;">Username: <strong style="font-size: 22px;">${esc(username)}</strong></p>
                    <p style="margin: 6px 0; font-size: 18px;">Password: <strong style="font-size: 22px;">${esc(password)}</strong></p>
                </div>

                <h3 style="color: #003366; font-size: 18px;">Important:</h3>
                <ul style="font-size: 16px; line-height: 1.8;">
                    <li>Your credentials are <strong>one-time use only</strong></li>
                    <li>Do not share your credentials with anyone</li>
                    ${startTime ? `<li>Login will not be available until the exam start time</li>` : ''}
                    <li>Once logged in, you will see your question stem(s) and any clinical images</li>
                </ul>

                <p style="color: #888; font-size: 14px; margin-top: 25px; border-top: 1px solid #eee; padding-top: 15px;">
                    This is an automated message from the ECU Mock Oral Platform.<br>
                    Questions? Contact the exam coordinator.
                </p>
            </div>
        </div>
    `;

    return transporter.sendMail({
        from: FROM,
        to: residentEmail,
        subject: `Mock Oral Exam Credentials — ${String(examName).replace(/[<>]/g, '')}${examDate ? ` (${String(examDate).replace(/[<>]/g, '')})` : ''}`,
        html
    });
}

// Verify email configuration works
async function verifyEmailConfig() {
    try {
        await transporter.verify();
        return true;
    } catch (err) {
        console.error('Email config error:', err.message);
        return false;
    }
}

module.exports = {
    sendExaminerEmail,
    sendResidentEmail,
    verifyEmailConfig
};
