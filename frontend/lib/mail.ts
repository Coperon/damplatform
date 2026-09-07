import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { AppError } from './errors';

export function mailConfigured(): boolean {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
}

function fromAddress(): string {
  return process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@localhost';
}

function createTransporter() {
  if (!mailConfigured()) {
    throw new AppError(503, 'Email is not configured (set SMTP_USER and SMTP_PASS).');
  }
  const host = process.env.SMTP_HOST;
  if (host) {
    const options: SMTPTransport.Options = {
      host,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    };
    return nodemailer.createTransport(options);
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

export async function sendResetEmail(to: string, resetLink: string) {
  await createTransporter().sendMail({
    from: fromAddress(),
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
  await createTransporter().sendMail({
    from: fromAddress(),
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
  await createTransporter().sendMail({
    from: fromAddress(),
    to,
    subject: 'You’ve been invited to the DAM platform',
    text: `You've been invited to join ${tenantName} on the DAM platform as ${roleName}. Open this link to set up your account (valid for 7 days):\n\n${inviteLink}\n\nIf you weren't expecting this invitation, you can ignore this email.`,
  });
}
