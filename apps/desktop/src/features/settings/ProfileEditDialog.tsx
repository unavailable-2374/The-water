import { useEffect, useState } from 'react';
import { validateHandle } from '@the-water/shared';
import { t } from '@/i18n';
import { Button, Dialog, Field, Input, Spinner, Textarea, cn } from '@/components/ui';
import { toast } from '@/components/Toast';
import { friendlyError } from '@/community/errors';
import { getClient, updateLocalProfile } from '@/sync/account';
import { useAccount } from '@/stores/accountStore';
import { useCommunity } from '@/stores/communityStore';

interface Props {
  open: boolean;
  onClose: () => void;
  initial: { displayName: string; handle: string; bio: string };
}

type HandleState = { checking: boolean; message: string | null; ok: boolean };

/** 编辑昵称、@用户名与简介。用户名边打边查，避免提交后才知道重名。 */
export function ProfileEditDialog({ open, onClose, initial }: Props) {
  const refreshAccount = useAccount((s) => s.refresh);
  const loadMe = useCommunity((s) => s.loadMe);
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [handle, setHandle] = useState(initial.handle);
  const [bio, setBio] = useState(initial.bio);
  const [saving, setSaving] = useState(false);
  const [state, setState] = useState<HandleState>({ checking: false, message: null, ok: true });

  useEffect(() => {
    if (!open) return;
    setDisplayName(initial.displayName);
    setHandle(initial.handle);
    setBio(initial.bio);
    setState({ checking: false, message: null, ok: true });
  }, [open, initial.displayName, initial.handle, initial.bio]);

  useEffect(() => {
    const next = handle.trim().toLowerCase();
    if (!open || next === initial.handle) {
      setState({ checking: false, message: null, ok: true });
      return;
    }
    const invalid = validateHandle(next);
    if (invalid) {
      setState({ checking: false, message: invalid, ok: false });
      return;
    }
    setState({ checking: true, message: null, ok: false });
    const timer = setTimeout(async () => {
      try {
        const client = await getClient();
        if (!client) return;
        // 查得到就说明被占用了；404 才是可用。
        await client.getUserByHandle(next);
        setState({ checking: false, message: t.community.handleTaken, ok: false });
      } catch {
        setState({ checking: false, message: t.community.handleFree, ok: true });
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [handle, open, initial.handle]);

  const save = async () => {
    const nextHandle = handle.trim().toLowerCase();
    if (!displayName.trim()) {
      toast.error(t.settings.displayNameEmpty);
      return;
    }
    if (!state.ok) return;
    setSaving(true);
    try {
      const client = await getClient();
      if (!client) return;
      const { user } = await client.updateProfile({
        displayName: displayName.trim(),
        handle: nextHandle !== initial.handle ? nextHandle : undefined,
        bio: bio.trim() || null,
      });
      await updateLocalProfile({ displayName: user.displayName, handle: user.handle });
      await refreshAccount();
      await loadMe();
      toast.success(t.settings.profileUpdated);
      onClose();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t.community.editProfile} width="max-w-md">
      <div className="space-y-4">
        <Field label={t.community.displayName}>
          <Input value={displayName} maxLength={32} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field label={t.community.handle} hint={t.community.handleHint}>
          <div className="relative">
            <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-ink-400" aria-hidden="true">@</span>
            <Input className="pl-7" value={handle} maxLength={20} onChange={(e) => setHandle(e.target.value)} autoCapitalize="none" spellCheck={false} />
          </div>
        </Field>
        {(state.checking || state.message) && (
          <p role="status" className={cn('-mt-2 text-xs', state.ok ? 'text-tea-700 dark:text-tea-200' : 'text-cinnabar-600 dark:text-cinnabar-100')}>
            {state.checking ? t.settings.handleChecking : state.message}
          </p>
        )}
        <Field label={t.community.bio}>
          <Textarea rows={3} value={bio} maxLength={500} onChange={(e) => setBio(e.target.value)} placeholder={t.settings.bioPlaceholder} />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button variant="primary" onClick={save} disabled={saving || state.checking || !state.ok}>
            {saving && <Spinner className="h-3 w-3" />}
            {t.common.save}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
