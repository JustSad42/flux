-- Flux's helper inside mpv (loaded with --script; written next to input.conf on every start).
--  * tells the page where the mouse is over the video, so the controls show (and stay while the pointer is near the bottom)
--  * click = play/pause; while zoomed, drag = pan
--  * Ctrl+wheel = zoom toward the pointer; "flux-zoom-reset" (key 0) and every new file reset it
local mp = require 'mp'
local function act(...) mp.commandv('script-message', 'act', ...) end

local drag = nil

local function dims()
  local d = mp.get_property_native('osd-dimensions')
  if not d or not d.w or d.w <= 0 then return nil end
  return d, d.w - d.ml - d.mr, d.h - d.mt - d.mb -- window size, displayed video width/height (zoom included)
end

-- the page only needs "the mouse moved" and whether it is near the bottom: at most ~10 messages a second
-- (a 1000 Hz mouse would otherwise send 1000 through mpv, Rust and the page), but at once when it crosses the bottom zone
local last_sent, last_low, last_out = 0, nil, nil
mp.observe_property('mouse-pos', 'native', function(_, p)
  if not p then return end
  if not p.hover then
    if not last_out then last_out = true; last_low = nil; act('mouseout') end
    return
  end
  last_out = false
  local d = dims()
  if d and d.h > 0 then
    local y, now = p.y / d.h, mp.get_time()
    local low = y > 0.8
    if low ~= last_low or now - last_sent >= 0.1 then
      last_sent, last_low = now, low
      act('mouse', string.format('%.3f', y))
    end
  end
  if drag and drag.zoom > 0 then
    local dx, dy = p.x - drag.x, p.y - drag.y
    if math.abs(dx) + math.abs(dy) > 4 then drag.moved = true end
    if drag.moved then
      local _, vw, vh = dims()
      if vw and vw > 0 and vh > 0 then
        mp.set_property_number('video-pan-x', drag.px + dx / vw)
        mp.set_property_number('video-pan-y', drag.py + dy / vh)
      end
    end
  end
end)

mp.add_forced_key_binding('MBTN_LEFT', 'flux-click', function(t)
  if t.event == 'down' then
    local x, y = mp.get_mouse_pos()
    drag = { x = x, y = y, moved = false, zoom = mp.get_property_number('video-zoom', 0),
             px = mp.get_property_number('video-pan-x', 0), py = mp.get_property_number('video-pan-y', 0) }
  elseif t.event == 'up' then
    if drag and not drag.moved and not t.canceled then act('toggle') end
    drag = nil
  elseif t.event == 'press' then -- down+up in one (synthetic clicks)
    act('toggle')
  end
end, { complex = true })

local function zoom(step)
  local z = mp.get_property_number('video-zoom', 0)
  local nz = math.max(0, math.min(3, z + step))
  if math.abs(nz - z) < 1e-6 then return end
  local px, py = mp.get_property_number('video-pan-x', 0), mp.get_property_number('video-pan-y', 0)
  local d, vw, vh = dims()
  if nz <= 0.001 then
    nz, px, py = 0, 0, 0
  elseif d and vw > 0 and vh > 0 then
    -- keep the point under the pointer where it is: pan is in units of the displayed video size
    local mx, my = mp.get_mouse_pos()
    local dx, dy, k = mx - d.w / 2, my - d.h / 2, 2 ^ (nz - z)
    px = dx / (vw * k) - dx / vw + px
    py = dy / (vh * k) - dy / vh + py
  end
  mp.set_property_number('video-zoom', nz)
  mp.set_property_number('video-pan-x', px)
  mp.set_property_number('video-pan-y', py)
  mp.osd_message(string.format('Zoom %d%%', math.floor(100 * 2 ^ nz + 0.5)), 1)
end

local function reset()
  mp.set_property_number('video-zoom', 0)
  mp.set_property_number('video-pan-x', 0)
  mp.set_property_number('video-pan-y', 0)
end

mp.add_forced_key_binding('Ctrl+WHEEL_UP', 'flux-zoom-in', function() zoom(0.15) end, { repeatable = true })
mp.add_forced_key_binding('Ctrl+WHEEL_DOWN', 'flux-zoom-out', function() zoom(-0.15) end, { repeatable = true })
mp.register_script_message('flux-zoom', function(s) zoom(tonumber(s) or 0) end)
mp.register_script_message('flux-zoom-reset', function() reset(); mp.osd_message('Zoom 100%', 1) end)
mp.register_event('file-loaded', reset)
