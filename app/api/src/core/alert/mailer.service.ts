import { Injectable, Logger } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { Inject } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/configuration';

/**
 * 告警邮件（可选）：SMTP_HOST + ALERT_MAIL_TO 都非空才启用告警邮件；
 * 未配 = 纯日志告警（零外部依赖默认形态）。发送失败只记日志，绝不抛出影响监控主流程。
 *
 * 2026-11-06：源视频到期提醒需要「按上传者邮箱」发送，因此新增 sendTo(to, …)：
 * 只要 SMTP_HOST 配好即可用（不再依赖 ALERT_MAIL_TO）；既有告警邮件通道语义不变。
 */
@Injectable()
export class AlertMailerService {
  private readonly log = new Logger('AlertMailer');
  private readonly transport: Transporter | null = null;
  /** 既有告警通道开关：SMTP_HOST + ALERT_MAIL_TO */
  readonly enabled: boolean;
  /** SMTP 是否可用（用户级通知只要求 SMTP_HOST） */
  readonly smtpReady: boolean;
  private readonly from: string;
  private readonly to: string;

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    this.from = cfg.smtpFrom || cfg.smtpUser;
    this.to = cfg.alertMailTo;
    this.smtpReady = Boolean(cfg.smtpHost);
    this.enabled = Boolean(cfg.smtpHost && this.to);
    if (this.smtpReady) {
      this.transport = createTransport({
        host: cfg.smtpHost,
        port: cfg.smtpPort,
        secure: cfg.smtpPort === 465,
        auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass } : undefined,
        // 内网 SMTP 常见自签证书：默认放宽（发不出告警邮件比告警本身更糟），
        // 需要严格校验时显式配 SMTP_TLS_REJECT_UNAUTHORIZED=true
        tls: { rejectUnauthorized: (process.env.SMTP_TLS_REJECT_UNAUTHORIZED ?? '') === 'true' },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
      });
      this.log.log(`SMTP 已启用 → ${cfg.smtpHost}:${cfg.smtpPort}`
        + (this.to ? `, 告警收件 ${this.to}` : '（ALERT_MAIL_TO 未配置：告警邮件不发信，仅用于源视频到期提醒）'));
      if (!this.from) {
        this.log.warn('SMTP_FROM 未配置且 SMTP_USER 为空：部分 SMTP 服务器会以空发件人拒收，请补 SMTP_FROM');
      }
    }
  }

  /**
   * 发送一封告警邮件。
   * @returns true=已交给 SMTP；false=未配置（静默跳过）或发送失败（仅日志，不抛）
   * 返回值用于测试与调用方观测，监控主流程永远不因邮件失败中断。
   */
  async send(subject: string, text: string): Promise<boolean> {
    if (!this.enabled) return false;
    return this.sendTo(this.to, subject, text);
  }

  /**
   * 发送到指定收件人（源视频到期提醒用；只要求 SMTP_HOST 已配）。
   * @returns true=已交给 SMTP；false=SMTP 未配/无收件人/发送失败（仅日志，不抛）
   */
  async sendTo(to: string, subject: string, text: string): Promise<boolean> {
    if (!this.smtpReady || !this.transport || !to) return false;
    try {
      await this.transport.sendMail({
        from: this.from,
        to,
        subject: `[IE改善平台] ${subject}`,
        text,
      });
      this.log.log(`邮件已发送 → ${to}: ${subject}`);
      return true;
    } catch (e) {
      this.log.warn(`邮件发送失败 → ${to}（不影响主流程）: ${(e as Error).message}`);
      return false;
    }
  }
}
