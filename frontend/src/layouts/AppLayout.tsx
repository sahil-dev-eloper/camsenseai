import { Outlet } from 'react-router-dom';
import { Sidebar } from '@/components/layout/Sidebar';
import { Topbar } from '@/components/layout/Topbar';
import { useSocketEvent } from '@/hooks/useSocketEvent';
import { SocketEvents } from '@/services/socket';
import { triggerWeaponAlarm } from '@/utils/audioAlert';
import type { Alert } from '@/types';

/**
 * Main authenticated shell: fixed sidebar + topbar, scrollable content region.
 * All protected pages render into <Outlet /> so they share one consistent frame.
 */
export function AppLayout() {
  // Global weapon detection alarm: alerts the operator immediately when any camera raises a weapon alert
  useSocketEvent<Alert>(SocketEvents.ALERT_NEW, (alert) => {
    if (alert.type === 'weapon' || alert.severity === 'critical') {
      triggerWeaponAlarm();
    }
  });

  return (
    <div className="flex h-screen overflow-hidden bg-base">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar />
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
