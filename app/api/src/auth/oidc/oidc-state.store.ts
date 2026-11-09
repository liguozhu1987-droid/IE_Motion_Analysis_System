import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

const STATE_TTL_MS = 10 * 60_000;
/** OTK：60 秒有效、单次消费（交底书 §3.3，避免 Token 进入 URL/日志/Referer） */
const OTK_TTL_MS = 60_000;
const MAX_ENTRIES = 5000;

export interface PendingLogin {
  nonce: string;
  verifier: string;
  redirectUri: string;
  createdAt: number;
}

export interface OtkSession {
  accessToken: string;
  refreshToken: string;
  userId: string;
  createdAt: number;
}

/**
 * OIDC 登录中间态（D12：一期内存态）。
 *
 * 单实例 Node 部署可用；上 IIS/ARR 或多实例前必须改为落库（Redis/表），否则
 * 「在 A 实例发起登录、回调落到 B 实例」会 state 校验失败。方案文档 §2.9 已标注该前提。
 */
@Injectable()
export class OidcStateStore {
  private readonly states = new Map<string, PendingLogin>();
  private readonly otks = new Map<string, OtkSession>();

  private prune(): void {
    const now = Date.now();
    for (const [k, v] of this.states) if (now - v.createdAt > STATE_TTL_MS) this.states.delete(k);
    for (const [k, v] of this.otks) if (now - v.createdAt > OTK_TTL_MS) this.otks.delete(k);
  }

  putState(state: string, value: PendingLogin): void {
    this.prune();
    if (this.states.size >= MAX_ENTRIES) {
      /* 只踢最早一条：登录中点不应无限堆积（异常刷接口时的兜底） */
      const oldest = this.states.keys().next().value;
      if (oldest) this.states.delete(oldest);
    }
    this.states.set(state, value);
  }

  /** 一次性消费：无论校验是否通过都删除，防重放 */
  takeState(state: string): PendingLogin | null {
    const value = this.states.get(state);
    if (!value) return null;
    this.states.delete(state);
    if (Date.now() - value.createdAt > STATE_TTL_MS) return null;
    return value;
  }

  putOtk(payload: OtkSession): string {
    this.prune();
    const otk = randomBytes(32).toString('base64url');
    this.otks.set(otk, payload);
    return otk;
  }

  /** 一次性消费：重复兑换直接失效 */
  takeOtk(otk: string): OtkSession | null {
    const value = this.otks.get(otk);
    if (!value) return null;
    this.otks.delete(otk);
    if (Date.now() - value.createdAt > OTK_TTL_MS) return null;
    return value;
  }
}
