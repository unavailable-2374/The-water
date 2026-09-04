/**
 * 进程内指标 + Prometheus 文本输出（§4.3）。
 *
 * 刻意不引任何指标库：需要的只是三样东西——请求量、状态码分布、延迟分布，
 * 一个 Map 加一组固定桶就够了，多一个依赖不值。
 *
 * 标签只有 method / route / status。route 用的是**路由模板**（`/api/v1/novels/:id`）
 * 而不是真实路径，否则每个作品 id 都会变成一条新时间序列，指标基数会爆。
 */

/** 延迟直方图的桶（秒），覆盖 5ms – 10s。 */
export const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

interface Series {
  method: string;
  route: string;
  /** 状态码 → 次数 */
  byStatus: Map<number, number>;
  /** 与 LATENCY_BUCKETS 等长的累计计数（le 语义在渲染时累加） */
  buckets: number[];
  sum: number;
  count: number;
}

export class Metrics {
  private series = new Map<string, Series>();
  private inFlight = 0;
  private startedAt = Date.now();

  begin(): void {
    this.inFlight++;
  }

  end(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  observe(method: string, route: string, status: number, seconds: number): void {
    const key = `${method} ${route}`;
    let s = this.series.get(key);
    if (!s) {
      s = { method, route, byStatus: new Map(), buckets: new Array<number>(LATENCY_BUCKETS.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    s.byStatus.set(status, (s.byStatus.get(status) ?? 0) + 1);
    s.count++;
    s.sum += seconds;
    for (let i = 0; i < LATENCY_BUCKETS.length; i++) {
      if (seconds <= LATENCY_BUCKETS[i]!) s.buckets[i]!++;
    }
  }

  /** 便于测试与 /health 的粗略快照。 */
  snapshot(): { requests: number; inFlight: number; series: number } {
    let requests = 0;
    for (const s of this.series.values()) requests += s.count;
    return { requests, inFlight: this.inFlight, series: this.series.size };
  }

  /** Prometheus 文本格式（version 0.0.4）。 */
  render(nowMs: number = Date.now()): string {
    const out: string[] = [];
    out.push('# HELP http_requests_total HTTP 请求总数');
    out.push('# TYPE http_requests_total counter');
    for (const s of this.series.values()) {
      for (const [status, n] of [...s.byStatus].sort((a, b) => a[0] - b[0])) {
        out.push(`http_requests_total{method="${esc(s.method)}",route="${esc(s.route)}",status="${status}"} ${n}`);
      }
    }
    out.push('# HELP http_request_duration_seconds 请求延迟分布');
    out.push('# TYPE http_request_duration_seconds histogram');
    for (const s of this.series.values()) {
      const labels = `method="${esc(s.method)}",route="${esc(s.route)}"`;
      let acc = 0;
      for (let i = 0; i < LATENCY_BUCKETS.length; i++) {
        acc = s.buckets[i]!;
        out.push(`http_request_duration_seconds_bucket{${labels},le="${LATENCY_BUCKETS[i]}"} ${acc}`);
      }
      out.push(`http_request_duration_seconds_bucket{${labels},le="+Inf"} ${s.count}`);
      out.push(`http_request_duration_seconds_sum{${labels}} ${s.sum.toFixed(6)}`);
      out.push(`http_request_duration_seconds_count{${labels}} ${s.count}`);
    }
    out.push('# HELP http_requests_in_flight 正在处理的请求数');
    out.push('# TYPE http_requests_in_flight gauge');
    out.push(`http_requests_in_flight ${this.inFlight}`);
    out.push('# HELP process_uptime_seconds 进程运行时长');
    out.push('# TYPE process_uptime_seconds gauge');
    out.push(`process_uptime_seconds ${((nowMs - this.startedAt) / 1000).toFixed(3)}`);
    return `${out.join('\n')}\n`;
  }
}

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** 未知路由统一归到一个标签，避免扫描器把 404 打成无数条时间序列。 */
export const UNMATCHED_ROUTE = '<unmatched>';
