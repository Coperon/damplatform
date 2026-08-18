import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export async function sendResetEmail(to: string, resetLink: string) {
  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to,
    subject: 'Reset your DAM password',
    text: `You requested a password reset. Open this link to set a new password (valid for 30 minutes):\n\n${resetLink}\n\nIf you did not request this, you can ignore this email.`,
  });
}

export async function sendEmailChangeConfirmation(
  to: string,
  confirmLink: string,
  currentEmail: string,
) {
  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to,
    subject: 'Confirm your new DAM email address',
    text: `A request was made to change the login email on a DAM platform account (currently ${currentEmail}) to this address. Open this link to confirm the change (valid for 24 hours):\n\n${confirmLink}\n\nIf you did not request this, you can ignore this email — your login email will not change.`,
  });
}

export async function sendInvitationEmail(
  to: string,
  inviteLink: string,
  roleName: string,
  tenantName: string,
) {
  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to,
    subject: 'You’ve been invited to the DAM platform',
    text: `You've been invited to join ${tenantName} on the DAM platform as ${roleName}. Open this link to set up your account (valid for 7 days):\n\n${inviteLink}\n\nIf you weren't expecting this invitation, you can ignore this email.`,
  });
}
