'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

type Store = {
  id: number; store_key: string; name: string; domain: string;
  api_version: string; location_id: string | null; has_token: boolean;
};

const emptyForm = { storeKey: '', name: '', domain: '', accessToken: '', apiVersion: '2024-10', locationId: '' };

export default function StoresPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [msg, setMsg] = useState('');
  const router = useRouter();

  useEffect(() => { load(); }, []);

  async function load() {
    const res = await fetch('/api/scheduler/stores').then(r => r.json());
    if (res.ok) setStores(res.stores);
  }

  function startEdit(s: Store) {
    setEditingId(s.id);
    setForm({ storeKey: s.store_key, name: s.name, domain: s.domain, accessToken: '', apiVersion: s.api_version, locationId: s.location_id || '' });
    setMsg('Al editar, si dejas "Access token" vacío se mantiene el que ya tenía guardado. Escribe uno nuevo solo si quieres reemplazarlo.');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg('');
    if (editingId) {
      const res = await fetch(`/api/scheduler/stores/${editingId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      }).then(r => r.json());
      if (res.ok) { setMsg('Tienda actualizada.'); setEditingId(null); setForm(emptyForm); load(); }
      else setMsg('Error: ' + res.error);
    } else {
      const res = await fetch('/api/scheduler/stores', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      }).then(r => r.json());
      if (res.ok) { setMsg('Tienda agregada.'); setForm(emptyForm); load(); }
      else setMsg('Error: ' + res.error);
    }
  }

  async function remove(id: number) {
    if (!confirm('¿Eliminar esta tienda? También se pierde su catálogo en caché.')) return;
    await fetch(`/api/scheduler/stores/${id}`, { method: 'DELETE' });
    load();
  }

  async function logout() {
    await fetch('/api/scheduler/auth/logout', { method: 'POST' });
    router.push('/login');
  }

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Tiendas</h1>
        <div className="flex gap-4 text-sm">
          <a href="/scheduler" className="underline">Panel</a>
          <button onClick={logout} className="text-red-600 underline">Salir</button>
        </div>
      </div>

      <table className="w-full bg-white shadow rounded-lg text-sm">
        <thead className="bg-gray-50">
          <tr><th className="p-2 text-left">Nombre</th><th className="p-2 text-left">Dominio</th><th className="p-2 text-left">Token</th><th className="p-2 text-left">Location ID</th><th></th></tr>
        </thead>
        <tbody>
          {stores.map(s => (
            <tr key={s.id} className="border-t">
              <td className="p-2">{s.name}</td>
              <td className="p-2">{s.domain}</td>
              <td className="p-2">{s.has_token ? '✅ configurado' : '❌ falta'}</td>
              <td className="p-2">{s.location_id || '—'}</td>
              <td className="p-2 flex gap-2">
                <button onClick={() => startEdit(s)} className="text-blue-600 underline text-xs">Editar</button>
                <button onClick={() => remove(s.id)} className="text-red-600 underline text-xs">Eliminar</button>
              </td>
            </tr>
          ))}
          {!stores.length && <tr><td colSpan={5} className="p-3 text-gray-500">Aún no hay tiendas.</td></tr>}
        </tbody>
      </table>

      <h2 className="text-lg font-bold">{editingId ? 'Editar tienda' : 'Agregar nueva tienda'}</h2>
      {msg && <p className="text-sm bg-yellow-50 border border-yellow-200 rounded p-2">{msg}</p>}
      <form onSubmit={submit} className="bg-white shadow rounded-lg p-4 flex flex-col gap-3 max-w-md">
        <label className="text-sm">Clave interna (slug, sin espacios — ej. "stanley")
          <input required disabled={!!editingId} value={form.storeKey}
            onChange={e => setForm({ ...form, storeKey: e.target.value })}
            className="block border rounded px-2 py-1 mt-1 w-full disabled:bg-gray-100" />
        </label>
        <label className="text-sm">Nombre para mostrar
          <input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
            className="block border rounded px-2 py-1 mt-1 w-full" />
        </label>
        <label className="text-sm">Dominio (tu-tienda.myshopify.com)
          <input required value={form.domain} onChange={e => setForm({ ...form, domain: e.target.value })}
            className="block border rounded px-2 py-1 mt-1 w-full" />
        </label>
        <label className="text-sm">Access token (Admin API)
          <input required={!editingId} value={form.accessToken} onChange={e => setForm({ ...form, accessToken: e.target.value })}
            placeholder={editingId ? '(dejar vacío mantiene el actual)' : ''}
            className="block border rounded px-2 py-1 mt-1 w-full" />
        </label>
        <label className="text-sm">API version
          <input value={form.apiVersion} onChange={e => setForm({ ...form, apiVersion: e.target.value })}
            className="block border rounded px-2 py-1 mt-1 w-full" />
        </label>
        <label className="text-sm">Location ID (opcional, para inventario)
          <input value={form.locationId} onChange={e => setForm({ ...form, locationId: e.target.value })}
            className="block border rounded px-2 py-1 mt-1 w-full" />
        </label>
        <div className="flex gap-2">
          <button type="submit" className="bg-black text-white rounded px-3 py-1.5 text-sm">
            {editingId ? 'Guardar cambios' : 'Agregar tienda'}
          </button>
          {editingId && (
            <button type="button" onClick={() => { setEditingId(null); setForm(emptyForm); setMsg(''); }}
              className="bg-gray-200 rounded px-3 py-1.5 text-sm">Cancelar edición</button>
          )}
        </div>
      </form>
    </div>
  );
}
