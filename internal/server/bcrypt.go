package server

import "golang.org/x/crypto/bcrypt"

// bcrypt helpers: the TS server uses bcryptjs, so existing persisted hashes
// interoperate directly.

func bcryptHash(password string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	return string(b), err
}

func bcryptCompare(hash, password string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}
