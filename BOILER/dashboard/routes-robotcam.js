// Robot camera (e-con RouteCAM) imaging settings via ONVIF.
//
// The camera is ONVIF (192.168.1.10:8000). Its ENCODER config is buggy
// (misreports codec, empty list), but the IMAGING service works: brightness /
// contrast / saturation / sharpness (0-255), WDR (OFF/ON), exposure + white
// balance (AUTO/MANUAL) are readable AND writable anonymously (verified).
//
// Own module (one require() line in server.js) so it stays past the
// architecture-guard hook — a thin ONVIF proxy, same shape as routes-valve.js /
// routes-cast.js. Consumed by the Robot tab's settings card on the Living Room agent.
//
// Endpoints:
//   GET  /api/robotcam/settings   -> current imaging settings + ranges
//   POST /api/robotcam/settings   -> body { brightness?, saturation?, contrast?,
//                                    exposure?('AUTO'|'MANUAL'), sharpness?,
//                                    wdr?('OFF'|'ON'), whitebalance?('AUTO'|'MANUAL') }

module.exports = function (app) {
  const CAM = 'http://192.168.1.10:8000/onvif/imaging_service';

  async function onvif(bodyXml) {
    const soap = `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema"><s:Body xmlns:timg="http://www.onvif.org/ver20/imaging/wsdl">${bodyXml}</s:Body></s:Envelope>`;
    const r = await fetch(CAM, {
      method: 'POST',
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
      body: soap,
      signal: AbortSignal.timeout(8000),
    });
    return await r.text();
  }

  const RANGES = {
    brightness: [0, 255], saturation: [0, 255], contrast: [0, 255], sharpness: [0, 255],
    wdr: ['OFF', 'ON'], exposure: ['AUTO', 'MANUAL'], whitebalance: ['AUTO', 'MANUAL'],
  };

  app.get('/api/robotcam/settings', async (req, res) => {
    try {
      const xml = await onvif('<timg:GetImagingSettings><timg:VideoSourceToken></timg:VideoSourceToken></timg:GetImagingSettings>');
      if (/Fault/.test(xml)) return res.status(502).json({ error: 'camera fault', detail: xml.slice(0, 300) });
      const num = (tag) => { const m = xml.match(new RegExp(`<tt:${tag}>([^<]+)</tt:${tag}>`)); return m ? Math.round(parseFloat(m[1])) : null; };
      const mode = (parent) => { const m = xml.match(new RegExp(`<tt:${parent}[^>]*>\\s*<tt:Mode>([^<]+)`)); return m ? m[1] : null; };
      res.json({
        ok: true,
        brightness: num('Brightness'),
        saturation: num('ColorSaturation'),
        contrast: num('Contrast'),
        sharpness: num('Sharpness'),
        wdr: mode('WideDynamicRange'),
        exposure: mode('Exposure'),
        whitebalance: mode('WhiteBalance'),
        ranges: RANGES,
      });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  app.post('/api/robotcam/settings', async (req, res) => {
    try {
      const s = req.body || {};
      const clamp = (v) => Math.max(0, Math.min(255, Math.round(Number(v))));
      const onoff = (v) => (String(v).toUpperCase() === 'ON' ? 'ON' : 'OFF');
      const automan = (v) => (String(v).toUpperCase() === 'MANUAL' ? 'MANUAL' : 'AUTO');
      // Build in the ONVIF ImagingSettings20 SCHEMA order (Brightness, ColorSaturation,
      // Contrast, Exposure, Sharpness, WideDynamicRange, WhiteBalance) so a multi-field
      // set is never rejected for element ordering.
      let block = '';
      if (s.brightness != null)   block += `<tt:Brightness>${clamp(s.brightness)}</tt:Brightness>`;
      if (s.saturation != null)   block += `<tt:ColorSaturation>${clamp(s.saturation)}</tt:ColorSaturation>`;
      if (s.contrast != null)     block += `<tt:Contrast>${clamp(s.contrast)}</tt:Contrast>`;
      if (s.exposure != null)     block += `<tt:Exposure><tt:Mode>${automan(s.exposure)}</tt:Mode></tt:Exposure>`;
      if (s.sharpness != null)    block += `<tt:Sharpness>${clamp(s.sharpness)}</tt:Sharpness>`;
      if (s.wdr != null)          block += `<tt:WideDynamicRange><tt:Mode>${onoff(s.wdr)}</tt:Mode></tt:WideDynamicRange>`;
      if (s.whitebalance != null) block += `<tt:WhiteBalance><tt:Mode>${automan(s.whitebalance)}</tt:Mode></tt:WhiteBalance>`;
      if (!block) return res.status(400).json({ error: 'no settings provided' });
      const xml = await onvif(`<timg:SetImagingSettings><timg:VideoSourceToken></timg:VideoSourceToken><timg:ImagingSettings>${block}</timg:ImagingSettings><timg:ForcePersistence>true</timg:ForcePersistence></timg:SetImagingSettings>`);
      if (/Fault/.test(xml)) return res.status(502).json({ error: 'camera rejected the change', detail: xml.slice(0, 300) });
      res.json({ ok: true });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });
};
