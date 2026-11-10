// Lists are an ordinary algebraic datatype. map is higher-order.
type List a = Nil | Cons a (List a)

let rec map f xs =
  match xs with
  | Nil -> Nil
  | Cons h t -> Cons (f h) (map f t)

let main = map (fun x -> x * 2) (Cons 1 (Cons 2 (Cons 3 Nil)))
