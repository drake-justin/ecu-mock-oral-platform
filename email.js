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

// Send email to an examiner with their credentials, examinees, and exam details
async function sendExaminerEmail({ examinerName, examinerEmail, username, password, examName, examDate, roomNumber, examinees, siteUrl }) {
    const url = siteUrl || SITE_URL;
    const examineeList = examinees.map(e =>
        `  - ${e.name} (PGY-${e.pgy_level}) — Credential: ${e.username} / ${e.password}`
    ).join('\n');

    const html = `
        <div style="font-family: Calibri, Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #003366; color: white; padding: 20px; text-align: center;">
                <h1 style="margin: 0; font-size: 22px;">ECU Mock Oral Examination</h1>
                <p style="margin: 5px 0 0; opacity: 0.8;">Examiner Assignment</p>
            </div>
            <div style="padding: 25px; border: 1px solid #ddd; border-top: none;">
                <p>Dear Dr. ${examinerName.split(',')[0].split(' ').pop()},</p>
                <p>You have been assigned as an examiner for the upcoming mock oral examination.</p>

                <div style="background: #f8f9fa; padding: 15px; border-radius: 6px; margin: 15px 0;">
                    <h3 style="color: #003366; margin: 0 0 10px;">Exam Details</h3>
                    <p style="margin: 4px 0;"><strong>Exam:</strong> ${examName}</p>
                    <p style="margin: 4px 0;"><strong>Date:</strong> ${examDate || 'TBD'}</p>
                    ${roomNumber ? `<p style="margin: 4px 0;"><strong>Room:</strong> ${roomNumber}</p>` : ''}
                </div>

                <div style="background: #003366; color: white; padding: 15px; border-radius: 6px; margin: 15px 0;">
                    <h3 style="margin: 0 0 10px;">Your Examiner Login</h3>
                    <p style="margin: 4px 0;">Website: <a href="${url}/examiner/login" style="color: #7cb9e8;">${url}/examiner/login</a></p>
                    <p style="margin: 4px 0;">Username: <strong>${username}</strong></p>
                    <p style="margin: 4px 0;">Password: <strong>${password}</strong></p>
                </div>

                <div style="background: #f0f4f8; padding: 15px; border-radius: 6px; margin: 15px 0;">
                    <h3 style="color: #003366; margin: 0 0 10px;">Your Examinees</h3>
                    <table style="width: 100%; border-collapse: collapse;">
                        <tr style="background: #003366; color: white;">
                            <th style="padding: 6px 10px; text-align: left;">Resident</th>
                            <th style="padding: 6px 10px; text-align: left;">PGY</th>
                            <th style="padding: 6px 10px; text-align: left;">Username</th>
                            <th style="padding: 6px 10px; text-align: left;">Password</th>
                        </tr>
                        ${examinees.map(e => `
                            <tr style="border-bottom: 1px solid #ddd;">
                                <td style="padding: 6px 10px;">${e.name}</td>
                                <td style="padding: 6px 10px;">PGY-${e.pgy_level}</td>
                                <td style="padding: 6px 10px; font-family: monospace;">${e.username}</td>
                                <td style="padding: 6px 10px; font-family: monospace;">${e.password}</td>
                            </tr>
                        `).join('')}
                    </table>
                </div>

                <p><strong>What to do:</strong></p>
                <ol>
                    <li>Log in to the Examiner Portal before the exam to review your question scenarios</li>
                    <li>Give each examinee their login credentials at exam time</li>
                    <li>Use the Score & Feedback tab to grade each examinee after their session</li>
                </ol>

                <p style="color: #888; font-size: 13px; margin-top: 20px;">
                    This is an automated message from the ECU Mock Oral Platform.<br>
                    Questions? Contact the exam coordinator.
                </p>
            </div>
        </div>
    `;

    return transporter.sendMail({
        from: FROM,
        to: examinerEmail,
        subject: `Mock Oral Exam Assignment — ${examName}${examDate ? ` (${examDate})` : ''}`,
        html
    });
}

// Send email to a resident with their exam credentials
async function sendResidentEmail({ residentName, residentEmail, username, password, examName, examDate, startTime, siteUrl }) {
    const url = siteUrl || SITE_URL;

    const html = `
        <div style="font-family: Calibri, Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #003366; color: white; padding: 20px; text-align: center;">
                <h1 style="margin: 0; font-size: 22px;">ECU Mock Oral Examination</h1>
                <p style="margin: 5px 0 0; opacity: 0.8;">Examinee Credentials</p>
            </div>
            <div style="padding: 25px; border: 1px solid #ddd; border-top: none;">
                <p>Dear ${residentName.split(',')[0]},</p>
                <p>You have been registered for the upcoming mock oral examination. Below are your login credentials.</p>

                <div style="background: #f8f9fa; padding: 15px; border-radius: 6px; margin: 15px 0;">
                    <h3 style="color: #003366; margin: 0 0 10px;">Exam Details</h3>
                    <p style="margin: 4px 0;"><strong>Exam:</strong> ${examName}</p>
                    <p style="margin: 4px 0;"><strong>Date:</strong> ${examDate || 'TBD'}</p>
                    ${startTime ? `<p style="margin: 4px 0;"><strong>Access opens:</strong> ${startTime}</p>` : ''}
                </div>

                <div style="background: #003366; color: white; padding: 15px; border-radius: 6px; margin: 15px 0;">
                    <h3 style="margin: 0 0 10px;">Your Login Credentials</h3>
                    <p style="margin: 4px 0;">Website: <a href="${url}" style="color: #7cb9e8;">${url}</a></p>
                    <p style="margin: 4px 0;">Username: <strong style="font-size: 18px;">${username}</strong></p>
                    <p style="margin: 4px 0;">Password: <strong style="font-size: 18px;">${password}</strong></p>
                </div>

                <p><strong>Important:</strong></p>
                <ul>
                    <li>Your credentials are one-time use only</li>
                    <li>Do not share your credentials with anyone</li>
                    ${startTime ? `<li>Login will not be available until the exam start time</li>` : ''}
                    <li>Once logged in, you will see your question stem(s) and any clinical images</li>
                </ul>

                <p style="color: #888; font-size: 13px; margin-top: 20px;">
                    This is an automated message from the ECU Mock Oral Platform.<br>
                    Questions? Contact the exam coordinator.
                </p>
            </div>
        </div>
    `;

    return transporter.sendMail({
        from: FROM,
        to: residentEmail,
        subject: `Mock Oral Exam Credentials — ${examName}${examDate ? ` (${examDate})` : ''}`,
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
