import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    // In production, replace console.log with a persistent store or monitoring system
    console.log('CSP Report received:', JSON.stringify(body));
  } catch (err) {
    console.error('Failed to parse CSP report', err);
  }

  return new Response(null, { status: 204 });
}
