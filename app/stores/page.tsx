'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

type StoreStatus = {
  id: number; key: string; name: string;
  state: 'connected' | 'expiring_soon' | 'expired' | 'not_connected';
  expiresAt: string | null; daysLeft: number | null;
};

const stateLabels: Record<string, string> = {
  connected: 'Conectada', expiring_soon: 'Token por vencer', expired: 'Token vencido', not_connected: 'No conectada',
};

const emptyForm = { storeKey: '', name: '', domain: '', clientId: '', clientSecret: '', apiVersion: '2024-10', locationId: '' };

export default function StoresPage() {
  const [stores, setStores] = useState<StoreStatus[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [msg, setMsg] = useState('');
  const [callbackUrl, setCallbackUrl] = useState('');
  const router = useRouter();

  useEffect(() => {
    load();
    if (typeof window !== 'undefined') {
      setCallbackUrl(`${window.location.origin}/api/scheduler/oauth/callback`);
    }
  }, []);

  async function load() {
    const res = await fetch('/api/scheduler/stores').then(r => r.json());
    if (res.ok) setStores(res.stores);
  }

  function startEdit(s: StoreStatus) {
    setEditingId(s.id);
    setForm({ storeKey: s.key, name: s.name, domain: '', clientId: '', clientSecret: '', apiVersion: '2024-10', locationId: '' });
    setMsg('Al editar, si dejas Client ID/Secret vacíos se mantienen los que ya tenía guardados. Rellena dominio y versión de API también, ya que se sobreescriben.');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg('');
    if (editingId) {
      const res = await fetch(`/api/scheduler/stores/${editingId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
      }).then(r => r.json());
      if (res.ok) { setMsg('Tienda actualizada.'); setEditingId(null); setForm(emptyForm); load(); }
      else setMsg('Error: ' + res.error);
    } else {
      const res = await fetch('/api/scheduler/stores', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
      }).then(r => r.json());
      if (res.ok) { setMsg('Tienda agregada. Ahora dale clic en "Conectar" para autorizarla.'); setForm(emptyForm); load(); }
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
        <h1 className="text-2xl font-bold">Tiendas Shopify</h1>
        <div className="flex gap-4 text-sm">
          <a href="/scheduler" className="underline">Panel</a>
          <button onClick={logout} className="text-red-600 underline">Salir</button>
        </div>
      </div>

      <table className="w-full bg-white shadow rounded-lg text-sm">
        <thead className="bg-gray-50">
          <tr><th className="p-2 text-left">Nombre</th><th className="p-2 text-left">Estado</th><th></th></tr>
        </thead>
        <tbody>
          {stores.map(s => (
            <tr key={s.id} className="border-t">
              <td className="p-2">{s.name}</td>
              <td className="p-2 flex items-center gap-2">
                <span className={`w-2.5 h-2.5 rounded-full inline-block ${
                  s.state === 'connected' ? 'bg-green-600' :
                  s.state === 'expiring_soon' ? 'bg-yellow-500' :
                  s.state === 'expired' ? 'bg-red-600' : 'bg-gray-400'
                }`} />
                {stateLabels[s.state]}{s.daysLeft !== null ? ` (${s.daysLeft}d)` : ''}
              </td>
              <td className="p-2 flex gap-2 items-center">
                <a href={`/api/scheduler/oauth/install?store=${s.key}`}>
                  <button className="px-2 py-1 bg-black text-white rounded text-xs">
                    {s.state === 'not_connected' ? 'Conectar' : 'Reconectar'}
                  </button>
                </a>
                <button onClick={() => startEdit(s)} className="text-blue-600 underline text-xs">Editar</button>
                <button onClick={() => remove(s.id)} className="text-red-600 underline text-xs">Eliminar</button>
              </td>
            </tr>
          ))}
          {!stores.length && <tr><td colSpan={3} className="p-3 text-gray-500">Aún no hay tiendas.</td></tr>}
        </tbody>
      </table>

      <h2 className="text-lg font-bold">{editingId ? 'Editar tienda' : 'Agregar tienda'}</h2>
      {msg && <p className="text-sm bg-yellow-50 border border-yellow-200 rounded p-2">{msg}</p>}
      <form onSubmit={submit} className="bg-white shadow rounded-lg p-4 flex flex-col gap-3 max-w-md">
        <label className="text-sm">Clave interna (slug, sin espacios — ej. "stanley")
          <input required disabled={!!editingId} value={form.storeKey}
            onChange={e => setForm({ ...form, storeKey: e.target.value })}
            className="block border rounded px-2 py-1 mt-1 w-full disabled:bg-gray-100" />
        </label>
        <label className="text-sm">Nombre (para identificarla en el sistema)
          <input required placeholder="Stanley 1913 MX" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
            className="block border rounded px-2 py-1 mt-1 w-full" />
        </label>
        <label className="text-sm">Dominio myshopify
          <input required placeholder="stanley-1913-mx.myshopify.com" value={form.domain} onChange={e => setForm({ ...form, domain: e.target.value })}
            className="block border rounded px-2 py-1 mt-1 w-full" />
        </label>
        <label className="text-sm">Client ID (de tu app en Shopify Partners)
          <input required={!editingId} value={form.clientId} onChange={e => setForm({ ...form, clientId: e.target.value })}
            placeholder={editingId ? '(dejar vacío mantiene el actual)' : ''}
            className="block border rounded px-2 py-1 mt-1 w-full" />
        </label>
        <label className="text-sm">Client Secret (de tu app en Shopify Partners)
          <input required={!editingId} value={form.clientSecret} onChange={e => setForm({ ...form, clientSecret: e.target.value })}
            placeholder={editingId ? '(dejar vacío mantiene el actual)' : ''}
            className="block border rounded px-2 py-1 mt-1 w-full" />
        </label>
        <label className="text-sm">Versión de API (opcional)
          <input placeholder="2024-10" value={form.apiVersion} onChange={e => setForm({ ...form, apiVersion: e.target.value })}
            className="block border rounded px-2 py-1 mt-1 w-full" />
        </label>
        <label className="text-sm">Location ID (opcional, para inventario)
          <input value={form.locationId} onChange={e => setForm({ ...form, locationId: e.target.value })}
            className="block border rounded px-2 py-1 mt-1 w-full" />
        </label>
        <div className="flex gap-2">
          <button type="submit" className="bg-black text-white rounded px-3 py-1.5 text-sm">
            {editingId ? 'Guardar cambios' : 'Guardar tienda'}
          </button>
          {editingId && (
            <button type="button" onClick={() => { setEditingId(null); setForm(emptyForm); setMsg(''); }}
              className="bg-gray-200 rounded px-3 py-1.5 text-sm">Cancelar edición</button>
          )}
        </div>
      </form>

      {callbackUrl && (
        <p className="text-xs text-gray-500">
          En la configuración de tu app en Shopify Partners, agrega esta URL en <strong>Allowed redirection URL(s)</strong>:<br />
          <code className="bg-gray-100 px-1 rounded">{callbackUrl}</code>
        </p>
      )}
    </div>
  );
}
