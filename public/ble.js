/* Web Bluetooth FTMS (Fitness Machine Service) client */

class Metrics {
  constructor() {
    this.speedKmh = 0; // km/h
    this.cadenceRpm = 0; // rpm
    this.distanceM = 0; // meters
  }
}

export class BLEWalker {
  constructor() {
    this.device = null;
    this.server = null;
    this.onData = null; // () => void; consumer reads this.metrics/this
    this.sensors = new Metrics();
    this._activeService = null; // 'FTMS' | null
    this.onConnectionChange = null; // (isConnected:boolean) => void
  }
  get activeService() { return this._activeService; }
  async connect() {
    const options = {
      // Restrict to FTMS devices only
      filters: [{ services: [0x1826] }],
      optionalServices: [0x1826],
    };
    this.device = await navigator.bluetooth.requestDevice(options);
    this.device.addEventListener('gattserverdisconnected', () => this._onDisconnected());
    this.server = await this.device.gatt.connect();
    // Only FTMS is supported
    if (await this._tryFTMS()) return;
    this._status('Connected (no FTMS service)');
    try { this.onConnectionChange?.(false); } catch {}
  }
  async disconnect() {
    try { this.device?.gatt?.disconnect(); } catch {}
    this._onDisconnected();
  }
  _onDisconnected() {
    this._activeService = null;
    this.device = null;
    this.server = null;
    this._status('Disconnected');
    try { this.onConnectionChange?.(false); } catch {}
  }
  _status(s) {
    document.getElementById('status').textContent = s;
  }
  async _tryFTMS() {
    try {
      const svc = await this.server.getPrimaryService(0x1826);
      const indoorBikeDataUUID = 0x2ad2; // Indoor Bike Data
      const ch = await svc.getCharacteristic(indoorBikeDataUUID);
      ch.addEventListener('characteristicvaluechanged', (e) => {
        const dv = e.target.value;
        this._onFTMS(dv);
        try { this.onData?.(); } catch {}
      });
      await ch.startNotifications();
      this._activeService = 'FTMS';
      this._status('Connected (FTMS: Indoor Bike)');
      try { this.onConnectionChange?.(true); } catch {}
      return true;
    } catch { return false; }
  }
  _onFTMS(dv) {
    const data = parseIndoorBikeData(dv);
    if (data.instantaneous_cadence != null) {
      this.sensors.cadenceRpm = Math.round(data.instantaneous_cadence);
    }
    if (data.instantaneous_speed != null) {
      this.sensors.speedKmh = data.instantaneous_speed;
    }
    if (data.total_distance != null) {
      this.sensors.distanceM = data.total_distance;
    }
  }
}

// Parses an FTMS Indoor Bike Data (0x2AD2) notification.
export function parseIndoorBikeData(dataView) {
  //SPEC: https://btprodspecificationrefs.blob.core.windows.net/gatt-specification-supplement/GATT_Specification_Supplement.pdf
  const flags = dataView.getUint16(0, true);
  let index = 2;
  const result = {};
  // Bit 0 is "More Data": when set, Instantaneous Speed is omitted from this record.
  if (!(flags & (1 << 0))) {
    result.instantaneous_speed = dataView.getUint16(index, true) * 0.01;  // Unit: km/h
    index += 2;
  }
  if (flags & (1 << 1)) {
    result.average_speed = dataView.getUint16(index, true) * 0.01;  // Unit: km/h
    index += 2;
  }
  if (flags & (1 << 2)) {
    result.instantaneous_cadence = dataView.getUint16(index, true) * 0.5;  // Unit: RPM
    index += 2;
  }
  if (flags & (1 << 3)) {
    result.average_cadence = dataView.getUint16(index, true) * 0.5;  // Unit: RPM
    index += 2;
  }
  if (flags & (1 << 4)) {
    result.total_distance = 
        dataView.getUint8(index) | 
        (dataView.getUint8(index + 1) << 8) | 
        (dataView.getUint8(index + 2) << 16);  // Unit: meter
    index += 3;
  }
  if (flags & (1 << 5)) {
    result.resistance_level = dataView.getUint8(index, true);
    index += 1;
  }
  if (flags & (1 << 6)) {
    result.instantaneous_power = dataView.getUint16(index, true);  // Unit: Watt
    index += 2;
  }
  if (flags & (1 << 7)) {
    result.average_power = dataView.getUint16(index, true);  // Unit: Watt
    index += 2;
  }
  if (flags & (1 << 8)) {
    result.total_energy = dataView.getUint16(index, true);  // Unit: kCal
    result.energy_per_hour = dataView.getUint16(index+2, true);  // Unit: kCal
    result.energy_per_minute = dataView.getUint8(index+4, true);  // Unit: kCal
    index += 5;
  }
  if (flags & (1 << 9)) {
    result.heart_rate = dataView.getUint8(index);  // Unit: BPM
    index += 1;
  }
  if (flags & (1 << 10)) {
    result.metabolic_equivalent = dataView.getUint8(index) * 0.1;  // Unit: METs
    index += 1;
  }
  if (flags & (1 << 11)) {
    result.elapsed_time = dataView.getUint16(index, true);  // Unit: sec
    index += 2;
  }
  if (flags & (1 << 12)) {
    result.remaining_time = dataView.getUint16(index, true);  // Unit: sec
    index += 2;
  }
  return result;
}
