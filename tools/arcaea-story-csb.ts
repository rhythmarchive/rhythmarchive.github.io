import { readFile } from "node:fs/promises";

export type CsbPoint = {
  x: number;
  y: number;
};

export type CsbScale = {
  x: number;
  y: number;
};

export type CsbSize = {
  width: number;
  height: number;
};

export type CsbNode = {
  classname: string;
  name: string;
  position: CsbPoint;
  scale: CsbScale;
  rotation: number;
  size: CsbSize;
  visible: boolean;
  resourcePath?: string;
  normalPath?: string;
  pressedPath?: string;
  text?: string;
  children: CsbNode[];
};

export type CsbDocument = {
  version: string;
  root: CsbNode;
};

class FlatBufferReader {
  private readonly view: DataView;
  private readonly decoder = new TextDecoder();

  public constructor(private readonly bytes: Uint8Array, readonly sourcePath: string) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private fail(message: string): never {
    throw new Error(`Invalid CSB ${this.sourcePath}: ${message}`);
  }

  private check(offset: number, length: number): void {
    if (!Number.isInteger(offset) || offset < 0 || length < 0 || offset + length > this.view.byteLength) {
      this.fail(`out-of-range read at ${offset} (+${length})`);
    }
  }

  private uint8(offset: number): number {
    this.check(offset, 1);
    return this.view.getUint8(offset);
  }

  private uint16(offset: number): number {
    this.check(offset, 2);
    return this.view.getUint16(offset, true);
  }

  private int32(offset: number): number {
    this.check(offset, 4);
    return this.view.getInt32(offset, true);
  }

  private uint32(offset: number): number {
    this.check(offset, 4);
    return this.view.getUint32(offset, true);
  }

  private float32(offset: number): number {
    this.check(offset, 4);
    return this.view.getFloat32(offset, true);
  }

  private isTable(offset: number | undefined): offset is number {
    if (offset === undefined || !Number.isInteger(offset) || offset < 4 || offset + 4 > this.view.byteLength) return false;
    const vtable = offset - this.int32(offset);
    if (vtable < 0 || vtable + 4 > this.view.byteLength) return false;
    const vtableSize = this.uint16(vtable);
    const objectSize = this.uint16(vtable + 2);
    return vtableSize >= 4 && vtable + vtableSize <= this.view.byteLength && objectSize >= 4 && offset + objectSize <= this.view.byteLength;
  }

  private tableFieldAddress(table: number | undefined, fieldIndex: number): number | undefined {
    if (table === undefined) return undefined;
    const vtable = table - this.int32(table);
    const vtableSize = this.uint16(vtable);
    const fieldOffsetAddress = vtable + 4 + fieldIndex * 2;
    if (fieldOffsetAddress + 2 > vtable + vtableSize) return undefined;
    const fieldOffset = this.uint16(fieldOffsetAddress);
    return fieldOffset === 0 ? undefined : table + fieldOffset;
  }

  private tableFieldTable(table: number | undefined, fieldIndex: number): number | undefined {
    const address = this.tableFieldAddress(table, fieldIndex);
    if (address === undefined) return undefined;
    const target = address + this.uint32(address);
    return this.isTable(target) ? target : undefined;
  }

  private tableFieldString(table: number | undefined, fieldIndex: number): string | undefined {
    const address = this.tableFieldAddress(table, fieldIndex);
    return address === undefined ? undefined : this.string(address + this.uint32(address));
  }

  private tableFieldUint8(table: number | undefined, fieldIndex: number, fallback: number): number {
    const address = this.tableFieldAddress(table, fieldIndex);
    return address === undefined ? fallback : this.uint8(address);
  }

  private tableFieldStruct(table: number | undefined, fieldIndex: number, width: number): number | undefined {
    const address = this.tableFieldAddress(table, fieldIndex);
    if (address !== undefined && address + width > this.view.byteLength) {
      this.fail(`struct field ${fieldIndex} at ${address} exceeds file for table ${table}`);
    }
    return address;
  }

  private vectorTables(table: number | undefined, fieldIndex: number): number[] {
    const address = this.tableFieldAddress(table, fieldIndex);
    if (address === undefined) return [];
    const vector = address + this.uint32(address);
    const length = this.uint32(vector);
    const result: number[] = [];
    const elements = vector + 4;
    this.check(elements, length * 4);
    for (let index = 0; index < length; index += 1) {
      const element = elements + index * 4;
      result.push(element + this.uint32(element));
    }
    return result;
  }

  private string(address: number): string {
    const length = this.uint32(address);
    const start = address + 4;
    this.check(start, length);
    return this.decoder.decode(this.bytes.subarray(start, start + length));
  }

  private resourcePath(table: number | undefined): string | undefined {
    if (table === undefined) return undefined;
    const value = this.tableFieldString(table, 0);
    if (!value) return undefined;
    return value.replaceAll("\\", "/").replace(/^\.\//u, "");
  }

  private structPoint(address: number | undefined): CsbPoint {
    return address === undefined ? { x: 0, y: 0 } : { x: this.float32(address), y: this.float32(address + 4) };
  }

  private structScale(address: number | undefined): CsbScale {
    return address === undefined ? { x: 1, y: 1 } : { x: this.float32(address), y: this.float32(address + 4) };
  }

  private structSize(address: number | undefined): CsbSize {
    return address === undefined ? { width: 0, height: 0 } : { width: this.float32(address), height: this.float32(address + 4) };
  }

  private specializedOptions(treeOptions: number | undefined): number | undefined {
    if (treeOptions === undefined) return undefined;
    return this.tableFieldTable(treeOptions, 0);
  }

  private widgetOptions(specialized: number | undefined): number | undefined {
    if (specialized === undefined) return undefined;
    return this.tableFieldTable(specialized, 0);
  }

  private parseNodeOptions(treeOptions: number | undefined, classname: string): {
    widget?: number | undefined;
    resourcePath?: string | undefined;
    normalPath?: string | undefined;
    pressedPath?: string | undefined;
    text?: string | undefined;
  } {
    const specialized = this.specializedOptions(treeOptions);
    const widget = this.widgetOptions(specialized);
    if (specialized === undefined) return {};

    if (classname === "ProjectNode") {
      return { widget, resourcePath: this.tableFieldString(specialized, 1) };
    }
    if (classname === "Button") {
      return {
        widget,
        normalPath: this.resourcePath(this.tableFieldTable(specialized, 1)),
        pressedPath: this.resourcePath(this.tableFieldTable(specialized, 2)),
        text: this.tableFieldString(specialized, 5),
      };
    }
    if (classname === "Sprite" || classname === "ImageView" || classname === "ParticleSystem" || classname === "GameMap") {
      return { widget, resourcePath: this.resourcePath(this.tableFieldTable(specialized, 1)) };
    }
    if (classname === "Text") {
      return { widget, text: this.tableFieldString(specialized, 4) };
    }
    if (classname === "TextAtlas") {
      return { widget, text: this.tableFieldString(specialized, 2) };
    }
    if (classname === "TextBMFont") {
      return { widget, text: this.tableFieldString(specialized, 2) };
    }
    return { widget };
  }

  private parseNode(table: number): CsbNode {
    const classname = this.tableFieldString(table, 0) ?? "Node";
    const children = this.vectorTables(table, 1).map((child) => this.parseNode(child));
    const treeOptions = this.tableFieldTable(table, 2);
    const parsed = this.parseNodeOptions(treeOptions, classname);
    const widget = parsed.widget;
    if (widget !== undefined && (widget < 0 || widget >= this.view.byteLength)) {
      this.fail(`node ${classname}/${table} resolved WidgetOptions ${widget} from Options ${treeOptions}`);
    }
    const position = this.structPoint(this.tableFieldStruct(widget, 7, 8));
    const scale = this.structScale(this.tableFieldStruct(widget, 8, 8));
    const rotationAddress = this.tableFieldStruct(widget, 2, 8);
    const rotation = rotationAddress === undefined ? 0 : this.float32(rotationAddress);
    const size = this.structSize(this.tableFieldStruct(widget, 11, 8));
    const visible = this.tableFieldUint8(widget, 4, 1) !== 0;
    const name = widget === undefined ? "" : (this.tableFieldString(widget, 0) ?? "");
    return {
      classname,
      name,
      position,
      scale,
      rotation,
      size,
      visible,
      ...(parsed.resourcePath ? { resourcePath: parsed.resourcePath } : {}),
      ...(parsed.normalPath ? { normalPath: parsed.normalPath } : {}),
      ...(parsed.pressedPath ? { pressedPath: parsed.pressedPath } : {}),
      ...(parsed.text ? { text: parsed.text } : {}),
      children,
    };
  }

  public document(): CsbDocument {
    const root = this.uint32(0);
    const documentTable = root;
    const version = this.tableFieldString(documentTable, 0) ?? "";
    const nodeTree = this.tableFieldTable(documentTable, 3);
    if (nodeTree === undefined) this.fail("missing NodeTree root");
    return { version, root: this.parseNode(nodeTree) };
  }
}

export function parseCsb(bytes: Uint8Array, sourcePath: string): CsbDocument {
  return new FlatBufferReader(bytes, sourcePath).document();
}

export async function readCsbFile(sourcePath: string): Promise<CsbDocument> {
  return parseCsb(await readFile(sourcePath), sourcePath);
}
