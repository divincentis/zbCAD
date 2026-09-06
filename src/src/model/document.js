import { DEFAULT_LINETYPE, DEFAULT_LINEWEIGHT, DIM_REF_PARTS, DIM_TYPES, DOCUMENT_FORMAT, DOCUMENT_VERSION, LINETYPES, LINEWEIGHTS, TAU } from '../core/constants.js';
import { DEFAULT_DIM_STYLE_ID, defaultDimStyle, derivedNextLayerId } from '../core/defaults.js';
import { parseDimStyle } from '../core/dimstyle.js';
import { bulgeArc, dist, normalizeAngle } from '../core/math.js';
import { parseUnitSettings } from '../core/units.js';
import { dimensionGeometry } from './dimension.js';
import { cloneDimStyles, cloneEntities, cloneLayers, entityArea, entityBBox, entityLength } from './entity.js';
import { state } from '../state.js';

export function editSnapshot() {
  return {
    entities: cloneEntities(),
    layers: cloneLayers(),
    dimStyles: cloneDimStyles(),
    unitSettings: { ...state.unitSettings },
    currentLayerId: state.currentLayerId,
    nextId: state.nextId,
    nextLayerId: state.nextLayerId,
  };
}

export function restoreEditSnapshot(snapshot) {
  state.entities = snapshot.entities;
  state.layers = snapshot.layers;
  if (snapshot.dimStyles) state.dimStyles = snapshot.dimStyles.map(style => ({ ...style }));
  if (snapshot.unitSettings) state.unitSettings = { ...snapshot.unitSettings };
  state.currentLayerId = snapshot.currentLayerId;
  state.nextId = snapshot.nextId;
  state.nextLayerId = snapshot.nextLayerId || derivedNextLayerId(snapshot.layers);
}

export function documentSnapshot() {
  return {
    format: DOCUMENT_FORMAT,
    version: DOCUMENT_VERSION,
    name: state.drawingName,
    units: { ...state.unitSettings },
    layers: cloneLayers(),
    dimStyles: cloneDimStyles(),
    currentLayerId: state.currentLayerId,
    nextId: state.nextId,
    nextLayerId: state.nextLayerId,
    entities: state.entities,
  };
}

export function exportDocumentText(pretty = true) {
  const document = documentSnapshot();
  const checked = validateDocumentData(document);
  if (checked.error) throw new Error(checked.error);
  return JSON.stringify(document, null, pretty ? 2 : 0);
}

export function cleanPoint(value) {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
  return { x: value.x, y: value.y };
}

// Validation never resolves a reference against the entity table (see
// updateAssociativeDimensions for that). A reference to a missing entity is
// accepted rather than rejected: the dimension still measures its last
// committed points fine without it, and dropping the reference would
// permanently sever an association that a later undo/redo could restore.
export function cleanEntityRefs(value) {
  if (value === undefined || value === null) return { value: [null, null] };
  if (!Array.isArray(value) || value.length !== 2) return { error: 'must be a pair' };
  const cleaned = [];
  for (const ref of value) {
    if (ref === null || ref === undefined) { cleaned.push(null); continue; }
    if (typeof ref !== 'object' || Array.isArray(ref)) return { error: 'must be an object or null' };
    if (!Number.isSafeInteger(ref.entityId) || ref.entityId <= 0) return { error: 'has an invalid entity id' };
    if (!DIM_REF_PARTS.includes(ref.part)) return { error: `has an unsupported part ${String(ref.part)}` };
    const entry = { entityId: ref.entityId, part: ref.part };
    if (ref.part === 'VERTEX') {
      if (!Number.isSafeInteger(ref.index) || ref.index < 0) return { error: 'has an invalid vertex index' };
      entry.index = ref.index;
    }
    if (ref.part === 'QUAD' || ref.part === 'POINT') {
      if (!Number.isFinite(ref.angle)) return { error: `has an invalid ${ref.part.toLowerCase()} angle` };
      entry.angle = ref.angle;
    }
    if (ref.part === 'SEGMENT') {
      if (!Number.isFinite(ref.t)) return { error: 'has an invalid segment position' };
      entry.t = ref.t;
      // Only a polyline segment needs to say which one; a line has only one.
      if (ref.segmentIndex !== undefined) {
        if (!Number.isSafeInteger(ref.segmentIndex) || ref.segmentIndex < 0) {
          return { error: 'has an invalid segment index' };
        }
        entry.segmentIndex = ref.segmentIndex;
      }
    }
    cleaned.push(entry);
  }
  return { value: cleaned };
}

// A polyline's curved segments. The array is rejected outright rather than
// resized when its length disagrees with the points: every internal path that
// reshapes a polyline has to reshape its bulges with it, and a stale array
// silently truncated back into range would draw a plausible curve on the wrong
// segment. A trailing entry on an open polyline names a segment that does not
// exist, so that one is zeroed rather than refused — it is unambiguous.
export function cleanPolylineBulges(value, points, closed) {
  if (value === undefined || value === null) return { value: null };
  if (!Array.isArray(value)) return { error: 'has an invalid polyline bulge list' };
  if (value.length !== points.length) {
    return { error: 'has a polyline bulge list that does not match its points' };
  }
  const bulges = [];
  for (let index = 0; index < value.length; index++) {
    const bulge = value[index];
    if (!Number.isFinite(bulge)) return { error: 'has an invalid polyline bulge' };
    if (!closed && index === points.length - 1) { bulges.push(0); continue; }
    const next = closed && index === points.length - 1 ? points[0] : points[index + 1];
    if (bulge !== 0 && !bulgeArc(points[index], next, bulge)) {
      return { error: 'has a polyline bulge that describes no arc' };
    }
    bulges.push(bulge);
  }
  return { value: bulges.some(bulge => bulge !== 0) ? bulges : null };
}

export function cleanEntity(value, layerIds) {
  if (!value || typeof value !== 'object') return { error: 'must be an object' };
  if (!Number.isSafeInteger(value.id) || value.id <= 0 || value.id >= Number.MAX_SAFE_INTEGER) return { error: 'has an invalid ID' };
  const type = typeof value.type === 'string' ? value.type.toUpperCase() : '';
  const layerId = value.layerId === undefined ? '0' : String(value.layerId);
  if (!layerIds.has(layerId)) return { error: `references unknown layer ${layerId}` };
  const common = { id: value.id, type, layerId };

  if (type === 'LINE') {
    const a = cleanPoint(value.a);
    const b = cleanPoint(value.b);
    if (!a || !b || dist(a, b) <= 1e-9) return { error: 'has invalid line geometry' };
    return { entity: { ...common, a, b } };
  }

  if (type === 'PLINE') {
    if (!Array.isArray(value.points) || value.points.length < 2) return { error: 'has too few polyline points' };
    const points = value.points.map(cleanPoint);
    if (points.some(point => !point)) return { error: 'has an invalid polyline point' };
    if (points.some((point, index) => index > 0 && dist(point, points[index - 1]) <= 1e-9)) {
      return { error: 'has duplicate consecutive polyline points' };
    }
    const closed = Boolean(value.closed);
    if (closed && points.length < 3) return { error: 'has too few points to be closed' };
    if (closed && dist(points[0], points[points.length - 1]) <= 1e-9) {
      return { error: 'has a collapsed closing polyline segment' };
    }
    const bulges = cleanPolylineBulges(value.bulges, points, closed);
    if (bulges.error) return { error: bulges.error };
    const entity = { ...common, points, closed };
    if (bulges.value) entity.bulges = bulges.value;
    return { entity };
  }

  if (type === 'DIM') {
    if (!DIM_TYPES.includes(value.dimType)) return { error: `has an unsupported dimension type ${String(value.dimType)}` };
    const p1 = cleanPoint(value.p1);
    const p2 = cleanPoint(value.p2);
    const linePoint = cleanPoint(value.linePoint);
    if (!p1 || !p2 || !linePoint) return { error: 'has invalid dimension points' };
    if (dist(p1, p2) <= 1e-9) return { error: 'measures a zero-length distance' };
    const rotation = value.dimType === 'LINEAR' ? value.rotation : 0;
    if (!Number.isFinite(rotation)) return { error: 'has an invalid dimension rotation' };
    const styleId = typeof value.styleId === 'string' && value.styleId.trim()
      ? value.styleId.trim() : DEFAULT_DIM_STYLE_ID;
    const textOffset = value.textOffset === null || value.textOffset === undefined
      ? null : cleanPoint(value.textOffset);
    if (value.textOffset !== null && value.textOffset !== undefined && !textOffset) {
      return { error: 'has an invalid dimension text offset' };
    }
    const refs = cleanEntityRefs(value.refs);
    if (refs.error) return { error: `has an invalid dimension reference: ${refs.error}` };
    return {
      entity: {
        ...common,
        dimType: value.dimType,
        p1, p2, linePoint,
        rotation: normalizeAngle(rotation),
        styleId,
        textOffset,
        refs: refs.value,
      },
    };
  }

  if (type === 'CIRCLE') {
    const center = cleanPoint(value.center);
    if (!center || !Number.isFinite(value.radius) || value.radius <= 1e-9) return { error: 'has invalid circle geometry' };
    return { entity: { ...common, center, radius: value.radius } };
  }

  if (type === 'ARC') {
    const center = cleanPoint(value.center);
    const sweep = value.endAngle - value.startAngle;
    if (!center || !Number.isFinite(value.radius) || value.radius <= 1e-9 ||
        !Number.isFinite(value.startAngle) || !Number.isFinite(value.endAngle) ||
        sweep <= 1e-8 || sweep >= TAU - 1e-8) {
      return { error: 'has invalid arc geometry' };
    }
    const startAngle = normalizeAngle(value.startAngle);
    return {
      entity: {
        ...common,
        center,
        radius: value.radius,
        startAngle,
        endAngle: startAngle + sweep,
      },
    };
  }

  if (type === 'TEXT') {
    const position = cleanPoint(value.position);
    if (!position || !Number.isFinite(value.height) || value.height <= 1e-9) {
      return { error: 'has invalid text placement' };
    }
    if (!Number.isFinite(value.rotation)) return { error: 'has an invalid text rotation' };
    if (typeof value.content !== 'string' || !value.content.trim() || value.content.length > 1000) {
      return { error: 'has invalid text content' };
    }
    return {
      entity: {
        ...common,
        position,
        height: value.height,
        rotation: normalizeAngle(value.rotation),
        content: value.content,
      },
    };
  }

  return { error: `uses unsupported entity type ${type || '(missing)'}` };
}

export function parseDocumentText(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: 'The selected file is not valid JSON.' };
  }
  return validateDocumentData(value);
}

// Loading, edit commits, manual save, and recovery share this validation.
// Validation happens on raw numbers before JSON can turn Infinity into null.
export function validateDocumentData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'The selected file is not a drawing document.' };
  }
  if (value.format !== DOCUMENT_FORMAT) {
    return { error: 'The selected file is not a Browser 2D Draft drawing.' };
  }
  if (!Number.isSafeInteger(value.version) || value.version < 1) {
    return { error: 'The drawing has an invalid document version.' };
  }
  if (value.version > DOCUMENT_VERSION) {
    return { error: `This drawing requires a newer document version (${value.version}).` };
  }
  const parsedUnits = parseUnitSettings(value.units);
  if (parsedUnits.error) return { error: parsedUnits.error };

  if (!Array.isArray(value.layers) || !value.layers.length) {
    return { error: 'The drawing has no layer table.' };
  }
  const layers = [];
  const layerIds = new Set();
  const layerNames = new Set();
  for (let index = 0; index < value.layers.length; index++) {
    const layer = value.layers[index];
    if (!layer || typeof layer !== 'object') return { error: `Layer ${index + 1} is invalid.` };
    const id = typeof layer.id === 'string' ? layer.id.trim() : '';
    const name = typeof layer.name === 'string' ? layer.name.trim() : '';
    if (!id || !name) return { error: `Layer ${index + 1} is missing an ID or name.` };
    if (layerIds.has(id)) return { error: `Layer ID ${id} is duplicated.` };
    const normalizedName = name.toLocaleLowerCase();
    if (layerNames.has(normalizedName)) return { error: `Layer name ${name} is duplicated.` };
    layerIds.add(id);
    layerNames.add(normalizedName);
    layers.push({
      id,
      name,
      color: typeof layer.color === 'string' && /^#[0-9a-f]{6}$/i.test(layer.color)
        ? layer.color.toLowerCase()
        : '#d6d6d6',
      visible: layer.visible !== false,
      locked: layer.locked === true,
      // Version 4 files (and earlier) have none of these three — default them
      // to what a v4 file would have looked like if it could have held them.
      linetype: LINETYPES.includes(layer.linetype) ? layer.linetype : DEFAULT_LINETYPE,
      lineweight: LINEWEIGHTS.includes(Number(layer.lineweight)) ? Number(layer.lineweight) : DEFAULT_LINEWEIGHT,
      printable: layer.printable !== false,
    });
  }
  if (!layerIds.has('0')) return { error: 'The drawing is missing required layer 0.' };

  // Version 3 had no dimension styles. A v3 file gets the default set, which
  // is exactly what it would have had if it could have held dimensions.
  let dimStyles;
  if (value.dimStyles === undefined) {
    dimStyles = [defaultDimStyle(parsedUnits.settings.drawingUnit)];
  } else if (!Array.isArray(value.dimStyles) || !value.dimStyles.length) {
    return { error: 'The drawing has an invalid dimension style table.' };
  } else {
    dimStyles = [];
    const styleIds = new Set();
    for (let index = 0; index < value.dimStyles.length; index++) {
      const parsed = parseDimStyle(value.dimStyles[index], parsedUnits.settings.format);
      if (parsed.error) return { error: `Dimension style ${index + 1} ${parsed.error}.` };
      if (styleIds.has(parsed.style.id)) return { error: `Dimension style ${parsed.style.id} is duplicated.` };
      styleIds.add(parsed.style.id);
      dimStyles.push(parsed.style);
    }
    if (!styleIds.has(DEFAULT_DIM_STYLE_ID)) {
      return { error: `The drawing is missing required dimension style ${DEFAULT_DIM_STYLE_ID}.` };
    }
  }
  const styleIdSet = new Set(dimStyles.map(style => style.id));

  if (!Array.isArray(value.entities)) return { error: 'The drawing has no entity table.' };
  const entities = [];
  const entityIds = new Set();
  for (let index = 0; index < value.entities.length; index++) {
    const cleaned = cleanEntity(value.entities[index], layerIds);
    if (cleaned.error) return { error: `Entity ${index + 1} ${cleaned.error}.` };
    if (entityIds.has(cleaned.entity.id)) return { error: `Entity ID ${cleaned.entity.id} is duplicated.` };
    if (cleaned.entity.type === 'DIM' && !styleIdSet.has(cleaned.entity.styleId)) {
      return { error: `Entity ${index + 1} references unknown dimension style ${cleaned.entity.styleId}.` };
    }
    const geometryError = entityGeometryError(cleaned.entity, dimStyles);
    if (geometryError) return { error: `Entity ${index + 1} ${geometryError}.` };
    entityIds.add(cleaned.entity.id);
    entities.push(cleaned.entity);
  }

  const minimumNextId = entities.reduce((maximum, entity) => Math.max(maximum, entity.id + 1), 1);
  const suppliedNextId = Number.isSafeInteger(value.nextId) && value.nextId > 0 ? value.nextId : 1;
  const derivedLayerId = derivedNextLayerId(layers);
  const suppliedNextLayerId = Number.isSafeInteger(value.nextLayerId) && value.nextLayerId > 0
    ? value.nextLayerId
    : derivedLayerId;
  const currentLayerId = layerIds.has(String(value.currentLayerId)) ? String(value.currentLayerId) : '0';
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 120) : 'Untitled';
  return {
    document: {
      name,
      unitSettings: parsedUnits.settings,
      layers,
      dimStyles,
      currentLayerId,
      nextId: Math.max(minimumNextId, suppliedNextId),
      nextLayerId: Math.max(derivedLayerId, suppliedNextLayerId),
      entities,
    },
  };
}

export function entityGeometryError(entity, styles = state.dimStyles) {
  if (entity.type === 'DIM') {
    const style = styles.find(value => value.id === entity.styleId);
    if (!style) return 'references an unknown dimension style';
    const geometry = dimensionGeometry(entity, style);
    const points = [entity.p1, entity.p2, entity.linePoint, geometry.q1, geometry.q2,
      geometry.textAnchor, ...(geometry.extension1 || []), ...(geometry.extension2 || [])];
    if (!Number.isFinite(geometry.measure) || geometry.measure <= 1e-9 ||
        points.some(point => !cleanPoint(point))) return 'has invalid dimension geometry';
    return null;
  }
  const box = entityBBox(entity);
  const length = entityLength(entity);
  const area = entityArea(entity);
  if (!box || Object.values(box).some(value => !Number.isFinite(value)) ||
      !Number.isFinite(length) || !Number.isFinite(length * length) ||
      (area !== null && !Number.isFinite(area))) {
    return 'exceeds the supported numeric range';
  }
  return null;
}

// Report shape: [{ title, rows: [[label, value], ...], note }]
