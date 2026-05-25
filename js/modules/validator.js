let _validate = null;

async function getValidator() {
  if (_validate) return _validate;
  const schema = await fetch('./schemas/event.schema.json').then((r) => r.json());
  const ajv = new window.Ajv({ allErrors: true });
  _validate = ajv.compile(schema);
  return _validate;
}

export async function validateDataset(data) {
  try {
    const validate = await getValidator();
    const valid = validate(data);
    return { valid, errors: validate.errors ?? [] };
  } catch (e) {
    console.warn('Schema validation unavailable:', e.message);
    return { valid: true, errors: [] };
  }
}

export function formatValidationErrors(errors) {
  const lines = errors
    .slice(0, 15)
    .map((e) => `  ${e.dataPath || e.instancePath || '(root)'}: ${e.message}`);
  if (errors.length > 15) lines.push(`  … and ${errors.length - 15} more`);
  return lines.join('\n');
}
