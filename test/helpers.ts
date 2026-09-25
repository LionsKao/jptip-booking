import { env, exports } from 'cloudflare:workers';

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
