import { env, exports } from 'cloudflare:workers';
import { vi } from 'vitest';

export const SEEDED = {
  student: { email: 'student1@jptip.co.jp', role: 'student' as const },
  teacher: { email: 'teacher1@jptip.co.jp', role: 'teacher' as const },
  admin: { email: 'admin1@jptip.co.jp', role: 'admin' as const },
};

export function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(`https://example.com${path}`, init);
}

function jsonInit(body: unknown, init?: RequestInit): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  };
}

export async function requestOtp(email: string, role: string): Promise<Response> {
  return fetchWorker('/api/otp/request', jsonInit({ email, role }));
}

// Reads the OTP code straight out of D1, exactly like a real user would read
// it off the Teams message — avoids depending on ALLOW_ANY_OTP's bypass path
// for tests that just need "a logged-in session".
export async function latestOtpCode(email: string, role: string): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT code FROM otp_codes WHERE email = ? AND role = ? ORDER BY id DESC LIMIT 1`
  ).bind(email, role).first<{ code: string }>();
  if (!row) throw new Error(`no otp_codes row for ${role} ${email}`);
  return row.code;
}

export async function verifyOtp(email: string, role: string, code: string): Promise<Response> {
  return fetchWorker('/api/otp/verify', jsonInit({ email, role, code }));
}

// Full request+verify round trip against the real (non-bypass) code path,
// returning the `session=...` cookie header for use in later requests.
export async function login(email: string, role: string): Promise<string> {
  await requestOtp(email, role);
  const code = await latestOtpCode(email, role);
  const res = await verifyOtp(email, role, code);
  const setCookie = res.headers.get('Set-Cookie');
  if (!setCookie) throw new Error(`login(${role} ${email}) did not set a session cookie`);
  return setCookie.split(';')[0];
}

// 讓老師可以被預約這門課：開這門課、每天 00:00–23:59 都開放（老師／時段本身的檢查另外有專門的測試）
export async function makeTeacherBookable(courseId: number, teacherId = 1): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO teacher_courses (teacher_id, course_id) VALUES (?, ?)`).bind(teacherId, courseId).run();
  await env.DB.prepare(
    `INSERT INTO teacher_hours (teacher_id, day_of_week, start_time, end_time)
     SELECT ?, d.value, '00:00', '23:59' FROM json_each('[0,1,2,3,4,5,6]') d
     WHERE NOT EXISTS (SELECT 1 FROM teacher_hours h WHERE h.teacher_id = ? AND h.day_of_week = d.value AND h.start_time = '00:00' AND h.end_time = '23:59')`
  ).bind(teacherId, teacherId).run();
}

export function withCookie(cookie: string, init?: RequestInit): RequestInit {
  return { ...init, headers: { ...init?.headers, Cookie: cookie } };
}

// 攔截寄信用的 Microsoft Graph 呼叫（不會真的寄出），記錄送出的內容。token 的 expires_in 給 0，
// 讓每個測試都重新取 token，不受前一個測試快取的影響。測試結束要 vi.restoreAllMocks()。
export function mockGraph(sendMailStatus = 202) {
  const calls: { url: string; body: string; auth: string | null }[] = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('https://login.microsoftonline.com/') || url.startsWith('https://graph.microsoft.com/')) {
      calls.push({ url, body: String(init?.body ?? ''), auth: new Headers(init?.headers).get('Authorization') });
      if (url.startsWith('https://login.microsoftonline.com/')) return Response.json({ access_token: 'test-token', expires_in: 0 });
      return new Response(null, { status: sendMailStatus });
    }
    return realFetch(input, init);
  });
  return calls;
}

export interface SentMail {
  to: string;
  subject: string;
  html: string;
}

// mockGraph 記錄到的 sendMail 呼叫，整理成收件人／主旨／內容
export function sentMails(calls: ReturnType<typeof mockGraph>): SentMail[] {
  return calls.filter((c) => c.url.startsWith('https://graph.microsoft.com/')).map((c) => {
    const { message } = JSON.parse(c.body) as { message: { subject: string; body: { content: string }; toRecipients: { emailAddress: { address: string } }[] } };
    return { to: message.toRecipients[0].emailAddress.address, subject: message.subject, html: message.body.content };
  });
}
