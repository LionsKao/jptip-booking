import { env } from 'cloudflare:workers';
import { describe, it } from 'vitest';
import { fetchWorker, login, SEEDED, withCookie } from './helpers';

type Invoice = {
  teacherId: number;
  name: string;
  status: string;
  lessonCount: number;
  unitPrice: number | null;
  taxRate: number;
  unitPriceWithTax: number | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  missing: string[];
  receipt: { address: string; companyName: string; companyAddress: string };
};

const FULL_RECEIPT = { address: '北海道札幌市東区北14条東4丁目1-1-417', companyName: '株式会社ジェイピーティップ', companyAddress: '東京都中央区銀座1-16-7' };

let seq = 0;
async function createTeacher(adminCookie: string, receipt: Record<string, unknown> | null): Promise<number> {
  seq += 1;
  const res = await fetchWorker('/api/teachers', withCookie(adminCookie, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `請求書老師${seq}`, email: `invoice-teacher-${Date.now()}-${seq}@example.com`, ...(receipt ? { receipt } : {}) }),
  }));
  return ((await res.json()) as { id: number }).id;
}

// 直接寫入預約（過去的月份沒辦法透過預約 API 建立），學生、課程用種子資料
async function insertBookings(teacherId: number, rows: { date: string; time?: string; status: string }[]): Promise<void> {
  const course = (await env.DB.prepare(`INSERT INTO courses (name) VALUES (?) RETURNING id`).bind(`請求書課程-${teacherId}-${seq}`).first<{ id: number }>())!;
  const enrollment = (await env.DB.prepare(`INSERT INTO student_courses (student_id, course_id, total_sessions) VALUES (1, ?, 999) RETURNING id`).bind(course.id).first<{ id: number }>())!;
  await env.DB.batch(rows.map((row, i) => env.DB.prepare(
    `INSERT INTO bookings (booking_code, student_id, student_course_id, course_id, teacher_id, date, time, status) VALUES (?, 1, ?, ?, ?, ?, ?, ?)`
  ).bind(`INV-${teacherId}-${seq}-${i}`, enrollment.id, course.id, teacherId, row.date, row.time ?? '10:00', row.status)));
}

async function listInvoices(cookie: string, query: string): Promise<Response> {
  return fetchWorker(`/api/invoices?${query}`, withCookie(cookie));
}

describe('/api/invoices', () => {
  it('is admin-only', async ({ expect }) => {
    expect((await fetchWorker('/api/invoices?month=2031-06')).status).toBe(401);
    for (const account of [SEEDED.student, SEEDED.teacher]) {
      const cookie = await login(account.email, account.role);
      expect((await listInvoices(cookie, 'month=2031-06')).status).toBe(401);
      expect((await fetchWorker('/api/invoices/lessons?month=2031-06&teacherId=1', withCookie(cookie))).status).toBe(401);
    }
  });

  it('rejects an invalid month or teacherId', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    for (const query of ['', 'month=2031-13', 'month=2031-6', 'month=abc', 'month=2031-06&teacherId=x']) {
      expect((await listInvoices(cookie, query)).status).toBe(400);
    }
    expect((await fetchWorker('/api/invoices/lessons?month=2031-06', withCookie(cookie))).status).toBe(400);
  });

  it("counts only the month's completed lessons and computes the amount (1700 × 40 + 5% = 71,400)", async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const teacherId = await createTeacher(cookie, { ...FULL_RECEIPT, wage: '1700', taxRate: '5%' });
    const june = Array.from({ length: 40 }, (_, i) => ({ date: `2031-06-${String((i % 30) + 1).padStart(2, '0')}`, time: i < 30 ? '10:00' : '14:00', status: 'attended' }));
    await insertBookings(teacherId, [
      ...june,
      // 月份邊界外、以及沒完成的課都不算
      { date: '2031-05-31', status: 'attended' },
      { date: '2031-07-01', status: 'attended' },
      { date: '2031-06-15', time: '18:00', status: 'cancelled' },
      { date: '2031-06-16', time: '18:00', status: 'absent' },
      { date: '2031-06-17', time: '18:00', status: 'upcoming' },
      { date: '2031-06-18', time: '18:00', status: 'pending' },
    ]);

    const res = await listInvoices(cookie, `month=2031-06&teacherId=${teacherId}`);
    expect(res.status).toBe(200);
    const [invoice] = (await res.json()) as Invoice[];
    expect(invoice).toMatchObject({
      teacherId, lessonCount: 40, unitPrice: 1700, taxRate: 5, unitPriceWithTax: 1785,
      subtotal: 68_000, tax: 3_400, total: 71_400, missing: [], receipt: FULL_RECEIPT,
    });

    const may = (await (await listInvoices(cookie, `month=2031-05&teacherId=${teacherId}`)).json()) as Invoice[];
    expect(may[0].lessonCount).toBe(1);
    const july = (await (await listInvoices(cookie, `month=2031-07&teacherId=${teacherId}`)).json()) as Invoice[];
    expect(july[0].lessonCount).toBe(1);
    // 12 月的下一個月跨年
    expect((await (await listInvoices(cookie, `month=2031-12&teacherId=${teacherId}`)).json())).toEqual([]);
  });

  it('rounds the consumption tax down to the yen, and the tax-included unit price keeps its decimals', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const teacherId = await createTeacher(cookie, { ...FULL_RECEIPT, wage: '1550', taxRate: '5%' });
    await insertBookings(teacherId, [1, 2, 3].map((d) => ({ date: `2031-08-0${d}`, status: 'attended' })));
    const [invoice] = (await (await listInvoices(cookie, `month=2031-08&teacherId=${teacherId}`)).json()) as Invoice[];
    expect(invoice).toMatchObject({ lessonCount: 3, subtotal: 4_650, tax: 232, total: 4_882, unitPriceWithTax: 1627.5 });
  });

  it('lists what is missing instead of an amount when the receipt data is incomplete', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const noReceipt = await createTeacher(cookie, null);
    const noAddress = await createTeacher(cookie, { wage: '1600', taxRate: '0%', companyName: '株式会社ジェイピーティップ' });
    await insertBookings(noReceipt, [{ date: '2031-09-01', status: 'attended' }]);
    await insertBookings(noAddress, [{ date: '2031-09-02', status: 'attended' }]);

    const list = (await (await listInvoices(cookie, 'month=2031-09')).json()) as Invoice[];
    const a = list.find((i) => i.teacherId === noReceipt)!;
    expect(a).toMatchObject({ lessonCount: 1, unitPrice: null, total: null, missing: ['unitPrice', 'address', 'companyName', 'companyAddress'] });
    const b = list.find((i) => i.teacherId === noAddress)!;
    expect(b).toMatchObject({ unitPrice: 1600, taxRate: 0, total: 1_600, missing: ['address', 'companyAddress'] });
  });

  it('lists the lessons behind an invoice, in date and time order', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const teacherId = await createTeacher(cookie, { ...FULL_RECEIPT, wage: '1600', taxRate: '0%' });
    await insertBookings(teacherId, [
      { date: '2031-10-05', time: '14:00', status: 'attended' },
      { date: '2031-10-01', time: '10:00', status: 'attended' },
      { date: '2031-10-05', time: '09:00', status: 'attended' },
      { date: '2031-10-06', time: '09:00', status: 'cancelled' },
    ]);
    const res = await fetchWorker(`/api/invoices/lessons?month=2031-10&teacherId=${teacherId}`, withCookie(cookie));
    expect(res.status).toBe(200);
    const lessons = (await res.json()) as { date: string; time: string; status: string; studentName: string; course: string }[];
    expect(lessons.map((l) => `${l.date} ${l.time}`)).toEqual(['2031-10-01 10:00', '2031-10-05 09:00', '2031-10-05 14:00']);
    expect(lessons.every((l) => l.status === 'attended' && l.studentName && l.course)).toBe(true);
  });
});
