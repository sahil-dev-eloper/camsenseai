import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Modal, Input, Select, Button } from '@/components/ui';
import type { Person, PersonCategory, PersonInput } from '@/types';
import { personCategoryLabel } from '@/types';

/**
 * Register/Edit person form. Reused for both — the presence of `person`
 * switches it to edit mode. Emits a PersonInput to the parent, which owns the
 * API call, exactly as CameraFormModal does.
 *
 * Only Person ID and Name are required; email, department and role are
 * optional and are never forced. Client-side validation is a courtesy for fast
 * feedback — the backend's Zod schema and its uniqueness checks are
 * authoritative, and a server rejection is surfaced through `error`.
 *
 * This form never touches a face photograph. Enrollment is a separate,
 * explicit step (see FaceRegistrationStep) because it creates biometric data.
 */
const EMPTY: PersonInput = {
  personId: '',
  name: '',
  email: '',
  category: 'student',
  department: '',
  role: '',
};

const categoryOptions = (Object.keys(personCategoryLabel) as PersonCategory[]).map((value) => ({
  value,
  label: personCategoryLabel[value],
}));

type FieldErrors = Partial<Record<'personId' | 'name' | 'email', string>>;

/** Deliberately permissive: a shape check, not an attempt to out-validate RFC 5322. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validatePersonInput(form: PersonInput): FieldErrors {
  const errors: FieldErrors = {};

  const personId = form.personId.trim();
  if (!personId) {
    errors.personId = 'Person ID is required.';
  } else if (personId.length > 40) {
    errors.personId = 'Person ID must be 40 characters or fewer.';
  } else if (/\s/.test(personId)) {
    errors.personId = 'Person ID cannot contain spaces.';
  }

  const name = form.name.trim();
  if (!name) {
    errors.name = 'Full name is required.';
  } else if (name.length > 80) {
    errors.name = 'Name must be 80 characters or fewer.';
  }

  const email = (form.email ?? '').trim();
  if (email && !EMAIL_PATTERN.test(email)) {
    errors.email = 'Enter a valid email address, or leave it blank.';
  }

  return errors;
}

export function PersonFormModal({
  open,
  person,
  saving,
  error,
  onSubmit,
  onClose,
}: {
  open: boolean;
  person?: Person | null;
  saving: boolean;
  error?: string | null;
  onSubmit: (input: PersonInput) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<PersonInput>(EMPTY);
  const [errors, setErrors] = useState<FieldErrors>({});

  useEffect(() => {
    setErrors({});
    if (person) {
      setForm({
        personId: person.personId,
        name: person.name,
        email: person.email,
        category: person.category,
        department: person.department,
        role: person.role,
      });
    } else {
      setForm(EMPTY);
    }
  }, [person, open]);

  const set = <K extends keyof PersonInput>(key: K, value: PersonInput[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    // Clear only the three fields that can carry an inline error.
    if (key === 'personId' || key === 'name' || key === 'email') {
      setErrors((e) => {
        const next = { ...e };
        delete (next as Record<string, string | undefined>)[key];
        return next;
      });
    }
  };

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const found = validatePersonInput(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    onSubmit({
      ...form,
      personId: form.personId.trim(),
      name: form.name.trim(),
      email: (form.email ?? '').trim(),
      department: (form.department ?? '').trim(),
      role: (form.role ?? '').trim(),
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={person ? 'Edit Person' : 'Register Person'}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSubmit} loading={saving} disabled={saving}>
            {person ? 'Save changes' : 'Register person'}
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Person ID *"
            name="personId"
            placeholder="STU-1024"
            value={form.personId}
            onChange={(e) => set('personId', e.target.value)}
            error={errors.personId}
            disabled={!!person}
            required
          />
          <Input
            label="Full name *"
            name="name"
            placeholder="Full name as it should appear"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            error={errors.name}
            required
          />
        </div>

        <Input
          label="Email (optional)"
          name="email"
          type="email"
          placeholder="name@example.com"
          value={form.email ?? ''}
          onChange={(e) => set('email', e.target.value)}
          error={errors.email}
        />

        <div className="grid grid-cols-2 gap-4">
          <Select
            label="Category"
            name="category"
            value={form.category}
            onChange={(e) => set('category', e.target.value as PersonCategory)}
            options={categoryOptions}
          />
          <Input
            label="Department (optional)"
            name="department"
            placeholder="Computer Science"
            value={form.department ?? ''}
            onChange={(e) => set('department', e.target.value)}
          />
        </div>

        <Input
          label="Role / designation (optional)"
          name="role"
          placeholder="Lab Assistant"
          value={form.role ?? ''}
          onChange={(e) => set('role', e.target.value)}
        />

        <p className="text-xs text-content-faint">
          A registration photograph is added separately after the person exists. Until a usable face
          has been enrolled, this person cannot be recognized.
        </p>

        {error && (
          <p className="rounded-lg border border-critical/30 bg-critical/10 px-3 py-2 text-xs text-critical">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
