import nodemailer, { type Transporter } from "nodemailer";
import type { FastifyBaseLogger } from "fastify";
import type { Env } from "../config/env.js";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Outbound account email (verification links, password resets). The API only
 * ever sends plain-text transactional mail; templating lives with the caller.
 */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Development transport: the message is logged, nothing leaves the process. */
export class LogMailer implements Mailer {
  constructor(private readonly log: FastifyBaseLogger) {}

  send(message: MailMessage): Promise<void> {
    this.log.info({ to: message.to, subject: message.subject, text: message.text }, "account email");
    return Promise.resolve();
  }
}

/** Test transport: keeps every message so a test can read the link it carried. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];

  send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  /** Last message addressed to `to`, if any. */
  lastTo(to: string): MailMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to === to);
  }
}

/** Production transport: SMTP via nodemailer (SMTP_URL, MAIL_FROM). */
export class SmtpMailer implements Mailer {
  private readonly transporter: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transporter = nodemailer.createTransport(smtpUrl);
  }

  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }
}

/** Picks the transport the environment asks for (`MAIL_TRANSPORT`). */
export function mailerFromEnv(env: Env, log: FastifyBaseLogger): Mailer {
  if (env.MAIL_TRANSPORT === "smtp") {
    if (!env.SMTP_URL || !env.MAIL_FROM) {
      throw new Error("MAIL_TRANSPORT=smtp requires SMTP_URL and MAIL_FROM");
    }
    return new SmtpMailer(env.SMTP_URL, env.MAIL_FROM);
  }
  return new LogMailer(log);
}
