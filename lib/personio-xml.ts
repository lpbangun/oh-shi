export type PersonioPosition = {
  id: string;
  subcompany: string;
  office: string;
  department: string;
  title: string;
  descriptions: string[];
  employmentType: string;
  schedule: string;
  createdAt: string;
  salary: {
    min: string;
    max: string;
    currencyCode: string;
    currencySymbol: string;
    type: string;
  } | null;
};

type XmlNode = {
  name: string;
  text: string;
  children: XmlNode[];
};

const incomplete = (detail: string): never => {
  throw new Error(`personio returned an incomplete payload: ${detail}`);
};

function decodeXmlText(value: string) {
  const entity = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi;
  if (value.replace(entity, "").includes("&")) {
    incomplete("invalid or unknown character entity");
  }
  return value.replace(
    entity,
    (entity) => {
      const named: Record<string, string> = {
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&apos;": "'",
      };
      const lower = entity.toLowerCase();
      if (named[lower]) return named[lower];
      const hexadecimal = lower.startsWith("&#x");
      const codePoint = Number.parseInt(
        lower.slice(hexadecimal ? 3 : 2, -1),
        hexadecimal ? 16 : 10
      );
      return Number.isInteger(codePoint) &&
        codePoint >= 0 &&
        codePoint <= 0x10ffff &&
        !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? String.fromCodePoint(codePoint)
        : incomplete("invalid character entity");
    }
  );
}

function parseXmlDocument(xml: string) {
  const document: XmlNode = { name: "#document", text: "", children: [] };
  const stack = [document];
  let cursor = 0;
  let nodeCount = 0;
  while (cursor < xml.length) {
    if (xml.startsWith("<!--", cursor)) {
      const end = xml.indexOf("-->", cursor + 4);
      if (end < 0) incomplete("unterminated comment");
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", cursor)) {
      const end = xml.indexOf("]]>", cursor + 9);
      if (end < 0) incomplete("unterminated CDATA");
      if (stack.length === 1) incomplete("CDATA outside the root element");
      stack.at(-1)!.text += xml.slice(cursor + 9, end);
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<?", cursor)) {
      const end = xml.indexOf("?>", cursor + 2);
      if (end < 0) incomplete("unterminated processing instruction");
      if (stack.length !== 1 || document.children.length) {
        incomplete("processing instruction inside the document");
      }
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith("<!", cursor)) {
      incomplete("declarations and entities are not allowed");
    }
    if (xml[cursor] === "<") {
      const end = xml.indexOf(">", cursor + 1);
      if (end < 0) incomplete("unterminated tag");
      const raw = xml.slice(cursor + 1, end).trim();
      if (raw.startsWith("/")) {
        const name = raw.slice(1).trim();
        if (!/^[A-Za-z_][\w:.-]*$/.test(name) || stack.length === 1) {
          incomplete("invalid closing tag");
        }
        if (stack.at(-1)!.name !== name) incomplete("mismatched closing tag");
        stack.pop();
      } else {
        const selfClosing = raw.endsWith("/");
        const name = (selfClosing ? raw.slice(0, -1) : raw).trim();
        if (!/^[A-Za-z_][\w:.-]*$/.test(name)) {
          incomplete("attributes or invalid element names are not allowed");
        }
        nodeCount += 1;
        if (nodeCount > 100_000 || stack.length > 16) {
          incomplete("XML complexity limit exceeded");
        }
        const node: XmlNode = { name, text: "", children: [] };
        stack.at(-1)!.children.push(node);
        if (!selfClosing) stack.push(node);
      }
      cursor = end + 1;
      continue;
    }
    const end = xml.indexOf("<", cursor);
    const boundary = end < 0 ? xml.length : end;
    const value = decodeXmlText(xml.slice(cursor, boundary));
    if (stack.length === 1) {
      if (value.trim()) incomplete("text outside the root element");
    } else {
      stack.at(-1)!.text += value;
    }
    cursor = boundary;
  }
  if (stack.length !== 1) incomplete("unclosed element");
  if (document.children.length !== 1) incomplete("expected exactly one root element");
  return document.children[0];
}

function children(node: XmlNode, name: string) {
  return node.children.filter((child) => child.name === name);
}

function child(node: XmlNode, name: string, required = false) {
  const matches = children(node, name);
  if (matches.length > 1) incomplete(`duplicate ${name}`);
  if (required && !matches.length) incomplete(`missing ${name}`);
  return matches[0] || null;
}

function value(node: XmlNode, name: string, required = false) {
  const match = child(node, name, required);
  const result = match?.text.trim() || "";
  if (required && !result) incomplete(`empty ${name}`);
  return result;
}

export function parsePersonioPositions(xml: string): PersonioPosition[] {
  const root = parseXmlDocument(xml.replace(/^\uFEFF/, ""));
  if (root.name !== "workzag-jobs" || root.text.trim()) {
    incomplete("unexpected root element");
  }
  if (root.children.some((node) => node.name !== "position")) {
    incomplete("unexpected root child");
  }
  const seen = new Set<string>();
  return root.children.map((position) => {
    const allowedPositionFields = new Set([
      "id",
      "subcompany",
      "office",
      "department",
      "recruitingCategory",
      "name",
      "jobDescriptions",
      "employmentType",
      "seniority",
      "schedule",
      "yearsOfExperience",
      "keywords",
      "occupation",
      "occupationCategory",
      "createdAt",
      "salaryInformation",
    ]);
    if (
      position.text.trim() ||
      position.children.some((node) => !allowedPositionFields.has(node.name))
    ) incomplete("unexpected position structure");
    const positionFieldNames = position.children.map((node) => node.name);
    if (new Set(positionFieldNames).size !== positionFieldNames.length) {
      incomplete("duplicate position field");
    }
    const id = value(position, "id", true);
    if (!/^\d+$/.test(id) || seen.has(id)) incomplete("invalid or duplicate position id");
    seen.add(id);
    const descriptionsNode = child(position, "jobDescriptions", true)!;
    if (
      descriptionsNode.text.trim() ||
      descriptionsNode.children.some((node) => node.name !== "jobDescription")
    ) incomplete("invalid jobDescriptions collection");
    const descriptions = descriptionsNode.children.map((description) => {
      if (
        description.text.trim() ||
        description.children.some((node) => !["name", "value"].includes(node.name))
      ) incomplete("unexpected jobDescription structure");
      value(description, "name", true);
      return value(description, "value", true);
    });
    if (!descriptions.length) incomplete("empty jobDescriptions collection");
    const salaryNode = child(position, "salaryInformation");
    if (
      salaryNode &&
      (
        salaryNode.text.trim() ||
        salaryNode.children.some((node) =>
          !["min", "max", "currencyCode", "currencySymbol", "type"].includes(node.name)
        )
      )
    ) incomplete("unexpected salaryInformation structure");
    return {
      id,
      subcompany: value(position, "subcompany"),
      office: value(position, "office", true),
      department: value(position, "department"),
      title: value(position, "name", true),
      descriptions,
      employmentType: value(position, "employmentType"),
      schedule: value(position, "schedule"),
      createdAt: value(position, "createdAt"),
      salary: salaryNode
        ? {
            min: value(salaryNode, "min"),
            max: value(salaryNode, "max"),
            currencyCode: value(salaryNode, "currencyCode"),
            currencySymbol: value(salaryNode, "currencySymbol"),
            type: value(salaryNode, "type"),
          }
        : null,
    };
  });
}
