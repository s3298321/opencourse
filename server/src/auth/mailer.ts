/**
 * Where a code goes. SMTP when OPENCOURSE_SMTP_URL is set; otherwise, on a
 * development server only, an outbox: stdout and GET /dev/outbox, which is how
 * the app's own tests read a code. A server that is neither refuses to start,
 * because sign-up would silently never work.
 */
export interface Mail { to: string; subject: string; text: string }
export interface Mailer { send(mail: Mail): Promise<void> }

export class Outbox implements Mailer {
  readonly messages: (Mail & { at: string })[] = []
  constructor(private readonly echo = true) {}
  async send(mail: Mail): Promise<void> {
    this.messages.push({ ...mail, at: new Date().toISOString() })
    if (this.messages.length > 50) this.messages.shift()
    if (this.echo) console.log(`[outbox] to ${mail.to}: ${mail.subject}\n${mail.text}\n`)
  }
}

export async function smtpMailer(url: string, from: string): Promise<Mailer> {
  const { createTransport } = await import('nodemailer')
  const transport = createTransport(url)
  return { send: async (mail) => { await transport.sendMail({ from, ...mail }) } }
}
