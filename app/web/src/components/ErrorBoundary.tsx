import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** 路由键：变化时自动清除错误（页面级边界用，切页即恢复） */
  resetKey?: string;
  /** hash 变化时自动恢复（顶层边界用：顶栏已被卸载时仍能靠地址栏/链接返回） */
  resetOnHashChange?: boolean;
  /** 标题（页面级/顶层可区分） */
  title?: string;
}

interface State {
  error: Error | null;
}

/**
 * 顶层兜底（v3.60）：渲染期异常不再把整棵 React 树打白。
 *
 * 为什么需要：视频库曾因接口形状不符在渲染期抛错，整站变成空白页、顶栏消失，
 * 用户既看不到错误也无法返回。错误边界把异常收敛到出错的那一块：
 *  - 放在 <main> 里的页面级边界：顶栏/侧栏保留，可直接切走；
 *  - 放在 main.tsx 的顶层边界：连 App 都崩时仍给出可操作兜底。
 *
 * 边界（React 的固有限制）：事件处理器、异步回调、报错边界自身的渲染错误
 * 不会被捕获——这些请用 try/catch 或全局 unhandledrejection 另行处理。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 只记录，不上报（内网工具无遥测通道）；控制台保留完整组件栈便于排查
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  componentDidMount() {
    if (this.props.resetOnHashChange) window.addEventListener('hashchange', this.onHash);
  }

  componentWillUnmount() {
    window.removeEventListener('hashchange', this.onHash);
  }

  private onHash = () => {
    if (this.state.error) this.setState({ error: null });
  };

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const detail = String(error?.stack || error?.message || error).split('\n').slice(0, 6).join('\n');
    return (
      <div className="eb-wrap" role="alert" aria-live="assertive">
        <div className="eb-card">
          <h2>{this.props.title ?? '页面出错了'}</h2>
          <p className="eb-msg">
            这个页面遇到异常，已阻止白屏；其他页面与数据不受影响。
            可以先重试，或返回综合看板继续工作。
          </p>
          {import.meta.env.DEV && <pre className="eb-detail">{detail}</pre>}
          <div className="eb-acts">
            <button type="button" className="btn sm primary" onClick={this.reset}>重试</button>
            <a className="btn sm" href="#/dashboard" onClick={this.reset}>返回综合看板</a>
            <button type="button" className="btn sm" onClick={() => window.location.reload()}>刷新页面</button>
          </div>
        </div>
      </div>
    );
  }
}