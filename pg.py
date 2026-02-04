# --- Bonus Module: Error Handling Challenge (The Safety Net) ---

# 1. Create a function called 'dangerous_math'
#    - It takes a number 'x'.
#    - inside, try to print (100 / x).
#    - Wrap it in a try/except block.
#    - If it fails (ZeroDivisionError), print "Caught you!"

def dangerous_math(x):
    # Your code here...
    try:
        result = 100/x
        print(f"{result}")
    except ZeroDivisionError:
        print("Caught you!")


# 2. Test it with a safe number
dangerous_math(10)

# 3. Test it with ZERO (This would normally crash!)
dangerous_math(0)