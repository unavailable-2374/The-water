import type { Env } from '../env';

export interface MailMessage {
  to: string;
  subject: string;
  /** 纯文本正文；所有邮件都必须可读，HTML 是可选增强。 */
  text: string;
  html?: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

/** 开发与测试出口：只打印，不外发。 */
export function consoleMailer(): Mailer {
  return {
    async send(msg) {
      console.log(`[mail] → ${msg.to}\n  主题：${msg.subject}\n${msg.text.replace(/^/gm, '  ')}`);
    },
  };
}

/** 测试出口：收件箱可断言。 */
export function memoryMailer(): Mailer & { outbox: MailMessage[] } {
  const outbox: MailMessage[] = [];
  return {
    outbox,
    async send(msg) {
      outbox.push(msg);
    },
  };
}

function resendMailer(env: Env): Mailer {
  return {
    async send(msg) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.resendApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.mailFrom,
          to: [msg.to],
          subject: msg.subject,
          text: msg.text,
          ...(msg.html ? { html: msg.html } : {}),
        }),
      });
      if (!res.ok) throw new Error(`Resend 投递失败 ${res.status}: ${await res.text()}`);
    },
  };
}

/** SMTP 出口。SMTP_URL 形如 `smtps://user:pass@smtp.example.com:465`。 */
function smtpMailer(env: Env): Mailer {
  let transport: Promise<{ sendMail(o: Record<string, unknown>): Promise<unknown> }> | null = null;
  const connect = async () => {
    const nodemailer = await import('nodemailer');
    return nodemailer.createTransport(env.smtpUrl);
  };
  return {
    async send(msg) {
      transport ??= connect();
      const t = await transport;
      await t.sendMail({
        from: env.mailFrom,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        ...(msg.html ? { html: msg.html } : {}),
      });
    },
  };
}

export function createMailer(env: Env): Mailer {
  switch (env.mailTransport) {
    case 'resend':
      if (!env.resendApiKey) throw new Error('MAIL_TRANSPORT=resend 需要 RESEND_API_KEY');
      return resendMailer(env);
    case 'smtp':
      if (!env.smtpUrl) throw new Error('MAIL_TRANSPORT=smtp 需要 SMTP_URL');
      return smtpMailer(env);
    default:
      return consoleMailer();
  }
}
