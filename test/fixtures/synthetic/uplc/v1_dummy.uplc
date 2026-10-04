(program 1.0.0
  (lam datum
    (lam redeemer
      (lam context
        (force
          [ [ [ (force (builtin ifThenElse))
                [ [ (builtin equalsInteger) (con integer 1) ] (con integer 1) ] ]
              (delay (con unit ())) ]
            (delay (error)) ])))))
