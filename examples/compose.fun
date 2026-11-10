// inc(double(10)) = 21, built by composing two functions.
let compose f g = fun x -> f (g x)

let inc x = x + 1

let double x = x * 2

let main = compose inc double 10
