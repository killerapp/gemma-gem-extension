export function parseJsonText(text: string): unknown {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return JSON.parse(fenced ? fenced[1].trim() : trimmed)
}

export function normalizeJsonText(text: string): string {
  try {
    return JSON.stringify(parseJsonText(text))
  } catch {
    return text.trim()
  }
}

function schemaType(value: unknown): string {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

function expectedSchemaTypes(schema: Record<string, unknown>): string[] {
  if (typeof schema.type === 'string') return [schema.type]
  if (Array.isArray(schema.type)) return schema.type.filter(item => typeof item === 'string')
  return []
}

export function validateJsonSchemaValue(value: unknown, schema: unknown, path = '$'): string[] {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return []

  const typedSchema = schema as Record<string, unknown>
  const errors: string[] = []
  const expectedTypes = expectedSchemaTypes(typedSchema)
  if (expectedTypes.length > 0 && !expectedTypes.includes(schemaType(value))) {
    errors.push(`${path} must be ${expectedTypes.join(' or ')}, got ${schemaType(value)}`)
    return errors
  }

  if (schemaType(value) === 'object') {
    const record = value as Record<string, unknown>
    const required = Array.isArray(typedSchema.required)
      ? typedSchema.required.filter(item => typeof item === 'string')
      : []
    for (const key of required) {
      if (!(key in record)) errors.push(`${path}.${key} is required`)
    }

    const properties = typedSchema.properties
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
      for (const [key, childSchema] of Object.entries(properties)) {
        if (key in record) {
          errors.push(...validateJsonSchemaValue(record[key], childSchema, `${path}.${key}`))
        }
      }
    }
  }

  if (Array.isArray(value) && typedSchema.items) {
    value.forEach((item, index) => {
      errors.push(...validateJsonSchemaValue(item, typedSchema.items, `${path}[${index}]`))
    })
  }

  return errors
}

export function jsonSchemaErrors(text: string, schema: Record<string, unknown>): string[] {
  try {
    return validateJsonSchemaValue(parseJsonText(text), schema)
  } catch (error) {
    return [`$ must be valid JSON: ${error instanceof Error ? error.message : String(error)}`]
  }
}
