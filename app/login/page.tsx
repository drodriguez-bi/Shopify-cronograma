'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const res = await fetch('/api/scheduler/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }).then(r => r.json());
    if (res.ok) router.push('/scheduler');
    else setError(res.error || 'Error al iniciar sesión.');
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-900 to-gray-700">
      <form onSubmit={submit} className="bg-white rounded-xl p-8 w-80 flex flex-col gap-3">
        <h1 className="text-lg font-bold text-center mb-2">Shopify Scheduler</h1>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <input
          type="password" placeholder="Contraseña" value={password}
          onChange={e => setPassword(e.target.value)} required autoFocus
          className="border rounded px-3 py-2"
        />
        <button type="submit" className="bg-black text-white rounded px-3 py-2 font-semibold">Entrar</button>
      </form>
    </div>
  );
}
