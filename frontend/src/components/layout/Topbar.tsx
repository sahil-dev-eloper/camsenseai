import { useState } from 'react';
import { LogOut, ShieldCheck, Volume2, VolumeX } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/hooks/redux';
import { logout } from '@/store/slices/authSlice';
import { Button } from '@/components/ui';
import { isBuzzerMuted, toggleBuzzerMuted } from '@/utils/audioAlert';

/**
 * Top bar for the authenticated app: contextual title area, the operator's
 * identity, audio buzzer status toggle, and sign-out.
 */
export function Topbar() {
  const dispatch = useAppDispatch();
  const user = useAppSelector((s) => s.auth.user);
  const [buzzerMuted, setBuzzerMuted] = useState(isBuzzerMuted());

  const handleToggleBuzzer = () => {
    const next = toggleBuzzerMuted();
    setBuzzerMuted(next);
  };

  return (
    <header className="flex h-16 shrink-0 items-center justify-between border-b border-border bg-surface px-6">
      <div className="flex items-center gap-3 text-sm text-content-muted">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-brand" />
          <span>Security Operations Center</span>
        </div>
        <span className="text-border">|</span>
        <button
          type="button"
          onClick={handleToggleBuzzer}
          className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-all ${
            buzzerMuted
              ? 'bg-surface-elevated text-content-faint hover:text-content border border-border'
              : 'bg-safe/10 text-safe hover:bg-safe/20 border border-safe/30'
          }`}
          title={buzzerMuted ? 'Alarm buzzer is MUTED. Click to activate.' : 'Alarm buzzer is ACTIVE. Click to mute.'}
        >
          {buzzerMuted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5 animate-pulse text-safe" />}
          <span>{buzzerMuted ? 'Buzzer Off' : 'Buzzer Armed'}</span>
        </button>
      </div>

      <div className="flex items-center gap-4">
        {user && (
          <div className="text-right">
            <p className="text-sm font-medium text-content">{user.name}</p>
            <p className="text-xs capitalize text-content-faint">{user.role}</p>
          </div>
        )}
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<LogOut className="h-4 w-4" />}
          onClick={() => dispatch(logout())}
        >
          Sign out
        </Button>
      </div>
    </header>
  );
}
