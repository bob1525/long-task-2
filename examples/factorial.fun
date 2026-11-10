// Factorial of 5.
let rec factorial n =
  if n <= 1 then 1 else n * factorial (n - 1)

let main = factorial 5
