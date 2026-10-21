const revision = new URL(import.meta.url).searchParams.get('version');

async function poll(): Promise<void> {
  try {
    const response = await fetch('/__dev/version', { cache: 'no-store' });
    if (response.ok && (await response.text()) !== revision) {
      window.location.reload();
      return;
    }
  } catch {
    // The server can be briefly unavailable while it restarts.
  }
  window.setTimeout(() => { void poll(); }, 750);
}

if (revision !== null) void poll();
