// Area of a 3-by-4 rectangle, selected by a constructor pattern.
type Shape = Circle Int | Rect Int Int

let area s =
  match s with
  | Circle r -> r * r
  | Rect w h -> w * h

let main = area (Rect 3 4)
